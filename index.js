/**
 * dsh-btw —— 旁路问答（Host 半侧）
 *
 * 设计要点：
 *  - 旁路问答**不碰**主会话：不 append 任何 session 事件、不启用任何工具、不唤醒 Agent。
 *    它只做三件事：读一份只读快照 → 直接调 `ctx.llm.stream` → 把结果流回浏览器。
 *  - 读快照用 `session.deriveMessages()`（模型真正看到的那份历史），再压平成纯文本，
 *    截断到 MAX_CONTEXT_CHARS，并丢掉工具结果的大段正文，只留首行摘要 —— 这样既不占主
 *    对话上下文，旁路自己的 token 也受控。
 *  - 浏览器半侧通过两条同源 HTTP 路由通讯（和 dsh-pet 同一套载体）：
 *      POST /dsh-btw/ask      问题 → SSE 文本增量
 *      GET  /dsh-btw/pending  长轮询，等 `/btw` 命令投递的问题
 *    `/btw` 命令在 Host 侧入队，长轮询把它交给浏览器，于是侧栏不需要轮询即可秒开。
 *  - 模型选择：优先用该会话上一次真正请求用的 provider/model，回落到全局默认模型。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_ASK = '/dsh-btw/ask'
const ROUTE_PENDING = '/dsh-btw/pending'
const ROUTE_ACTIVE = '/dsh-btw/active'
const ROUTE_THREAD = '/dsh-btw/thread'

/** 旁路自己的记忆：按会话落盘，最多保留多少条消息 */
const MAX_THREAD_TURNS = 200
/** 单条记忆文本上限 */
const MAX_THREAD_TEXT = 20000
/** 送进旁路的快照上限（字符），超出只保留最近的尾巴 */
const MAX_CONTEXT_CHARS = 16000
/** 单条工具结果最多保留多少字符 */
const TOOL_RESULT_CLIP = 600
/** 旁路自己最多带多少轮本地追问历史（消息条数） */
const MAX_HISTORY_TURNS = 12
/** 单个问题的长度上限 */
const MAX_QUESTION_CHARS = 8000
/** 单条历史消息上限 */
const MAX_HISTORY_CHARS = 3000
/** 历史总预算（字符），保证连续追问不至于把主快照挤掉 */
const MAX_HISTORY_TOTAL_CHARS = 8000
/** 请求体上限 */
const MAX_BODY_BYTES = 512 * 1024
/** 长轮询挂起时长；到点回 204，浏览器立刻重新发起 */
const PENDING_HOLD_MS = 20000
/** 一次旁路回答的整体超时 */
const ASK_TIMEOUT_MS = 180000
/** 调用身份：适配器据此生成服务商需要的载体，稳定即可，不必是真实会话 id */
const CALL_IDENTITY = 'dsh-btw'

export const inject = ['webServer']

/**
 * 本地构造消息。形状与 `@deepseek-ai/dsh-llm` 的 createUserMessage/createAssistantMessage 一致
 * （{ id, role, content, source }），但只用 Node 内建模块实现 —— 装进 profile 之后，插件的
 * 裸包名解析环境不可靠（同仓的 dsh-pet 靠 peerDependencies 才拿得到），本插件不赌这一点。
 */
function createUserMessage(input) {
  return { id: randomUUID(), role: 'user', content: input.content, source: { kind: 'user' } }
}

function createAssistantMessage(input) {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: input.content,
    source: { kind: 'model', provider: input.source.provider, model: input.source.model },
  }
}

export function apply(ctx) {
  /** sessionId -> 排队中的问题 */
  const queued = new Map()
  /** sessionId -> Set<resolve> 正在等问题的长轮询 */
  const waiters = new Map()

  // ---------------------------------------------------------------- 队列

  function enqueue(sessionId, question) {
    const set = waiters.get(sessionId)
    if (set !== undefined && set.size > 0) {
      const first = set.values().next().value
      set.delete(first)
      if (set.size === 0) waiters.delete(sessionId)
      first(question)
      return
    }
    const list = queued.get(sessionId) ?? []
    list.push(question)
    queued.set(sessionId, list)
  }

  function takeQueued(sessionId) {
    const list = queued.get(sessionId)
    if (list === undefined || list.length === 0) return undefined
    const next = list.shift()
    if (list.length === 0) queued.delete(sessionId)
    return next
  }

  function waitForQuestion(sessionId, holdMs) {
    const ready = takeQueued(sessionId)
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve) => {
      let timer
      let done = false
      const settle = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        const set = waiters.get(sessionId)
        if (set !== undefined) {
          set.delete(settle)
          if (set.size === 0) waiters.delete(sessionId)
        }
        resolve(value)
      }
      let set = waiters.get(sessionId)
      if (set === undefined) {
        set = new Set()
        waiters.set(sessionId, set)
      }
      set.add(settle)
      timer = setTimeout(() => settle(null), holdMs)
    })
  }

  function releaseWaiters() {
    for (const [sessionId, set] of [...waiters]) {
      for (const settle of [...set]) settle(null)
      waiters.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------- 快照

  function textOf(content) {
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        out += block.text
      }
    }
    return out.trim()
  }

  function toolNamesOf(content) {
    if (!Array.isArray(content)) return []
    const names = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.name === 'string') {
        names.push(block.name)
      }
    }
    return names
  }

  function clip(text, limit) {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length <= limit ? flat : flat.slice(0, limit) + '…'
  }

  function buildTranscript(session) {
    let messages = []
    try {
      messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() ?? [] : []
    } catch {
      messages = []
    }
    const lines = []
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      const role = message.role
      if (role === 'user') {
        const text = textOf(message.content)
        if (text !== '') lines.push(`用户：${text}`)
        continue
      }
      if (role === 'assistant') {
        const text = textOf(message.content)
        const tools = toolNamesOf(message.content)
        if (text === '' && tools.length === 0) continue
        let line = `助手：${text === '' ? '（没有文字，只有工具调用）' : text}`
        if (tools.length > 0) line += `\n[调用工具] ${tools.join('、')}`
        lines.push(line)
        continue
      }
      if (role === 'tool') {
        const text = textOf(message.content)
        if (text !== '') lines.push(`[工具结果] ${clip(text, TOOL_RESULT_CLIP)}`)
      }
    }
    const joined = lines.join('\n\n')
    if (joined.length <= MAX_CONTEXT_CHARS) return joined
    return `（更早的内容已省略）\n\n${joined.slice(-MAX_CONTEXT_CHARS)}`
  }

  function buildSystemPrompt(transcript, session) {
    const cwd = session?.header?.cwd
    const parts = [
      '你是 DeepSeek Harness 里「旁路问答侧栏」（/btw）的助手。',
      '用户在主对话仍在执行或思考时，从侧栏向你提问。你的职责是让用户快速确认信息，而不是推进主任务。',
      '',
      '硬约束：',
      '- 你只有只读视野。下面给的是主对话的一份只读快照，可能被截断、也可能比此刻稍旧。',
      '- 你不能调用任何工具，不能读写文件，不能执行命令，也不能改变主对话。',
      '- 绝不要声称你执行了任何操作。若用户要求你动手（改文件、跑命令、提交代码），说明这需要回到主对话里做。',
      '- 不要复述整段会话。回答直接、简短、可执行，通常 1-3 段或一个短列表。',
      '- 如果快照里找不到依据，直说「当前对话里看不到」，不要猜测或编造事实；可以给出一般性建议，但要标清楚那是建议。',
      '- 你和用户在侧栏里**之前几轮问答**会作为对话历史一并给你；连续追问时保持前后一致，不要自相矛盾。',
      '- 事实来源始终以主对话快照为准：若你之前的说法与快照冲突，以快照为准并说明。',
      '- 用用户提问时使用的语言回答。',
    ]
    if (typeof cwd === 'string' && cwd !== '') parts.push('', `主对话的工作目录：${cwd}`)
    if (transcript.trim() === '') {
      parts.push('', '[主对话只读快照]', '（当前还没有可读的对话内容）')
    } else {
      parts.push('', '[主对话只读快照开始]', transcript, '[主对话只读快照结束]')
    }
    return parts.join('\n')
  }

  // ---------------------------------------------------------------- 模型

  function pickModel(session) {
    try {
      const context = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
      if (context !== undefined && context !== null && typeof context.provider === 'string' && typeof context.model === 'string') {
        return { provider: context.provider, model: context.model }
      }
    } catch {
      /* 忽略：回落到默认模型 */
    }
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection !== undefined && selection !== null && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* 忽略 */
    }
    return undefined
  }

  function buildHistoryTurns(raw, target) {
    const turns = []
    if (!Array.isArray(raw)) return turns
    // 从最近往前取，受"条数 + 总字符"双重预算约束，再翻回时间正序
    const picked = []
    let budget = MAX_HISTORY_TOTAL_CHARS
    const recent = raw.slice(-MAX_HISTORY_TURNS)
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const entry = recent[index]
      if (entry === null || typeof entry !== 'object') continue
      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : undefined
      if (role === undefined) continue
      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (text === '') continue
      const clipped = text.slice(0, Math.min(MAX_HISTORY_CHARS, budget))
      if (clipped === '') break
      budget -= clipped.length
      picked.push({ role, text: clipped })
      if (budget <= 0) break
    }
    picked.reverse()
    for (const turn of picked) {
      if (turn.role === 'user') {
        turns.push(createUserMessage({ content: [{ type: 'text', text: turn.text }], source: { kind: 'user' } }))
      } else {
        turns.push(createAssistantMessage({ content: [{ type: 'text', text: turn.text }], source: target }))
      }
    }
    return turns
  }

  // ---------------------------------------------------------------- 旁路记忆（落盘，应用重启也在）

  /** sessionId -> 已读入内存的消息数组 */
  const threads = new Map()

  function threadsDirectory() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'btw-threads')
  }

  /** 只接受安全字符，避免 sessionId 被拼成路径 */
  function validSessionId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  }

  function sanitizeThreadTurns(raw) {
    if (!Array.isArray(raw)) return []
    const clean = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      const role = entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : undefined
      if (role === undefined) continue
      const text = typeof entry.text === 'string' ? entry.text.slice(0, MAX_THREAD_TEXT) : ''
      if (text.trim() === '') continue
      clean.push({ role, text })
    }
    return clean.slice(-MAX_THREAD_TURNS)
  }

  async function readThread(sessionId) {
    if (threads.has(sessionId)) return threads.get(sessionId)
    let turns = []
    try {
      const raw = await readFile(join(threadsDirectory(), sessionId + '.json'), 'utf8')
      turns = sanitizeThreadTurns(JSON.parse(raw))
    } catch {
      turns = []
    }
    threads.set(sessionId, turns)
    return turns
  }

  async function writeThread(sessionId, turns) {
    const clean = sanitizeThreadTurns(turns)
    threads.set(sessionId, clean)
    try {
      const directory = threadsDirectory()
      await mkdir(directory, { recursive: true })
      const file = join(directory, sessionId + '.json')
      const temporary = file + '.tmp'
      await writeFile(temporary, JSON.stringify(clean), 'utf8')
      await rename(temporary, file)
    } catch {
      /* 落盘失败也不影响内存里的这一份 */
    }
  }

  // ---------------------------------------------------------------- HTTP 工具

  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function startEventStream(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
  }

  function sendEvent(res, payload, closed) {
    if (closed()) return
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      /* 管道已断，交给 close 处理 */
    }
  }

  function noTextReason(finish) {
    const kind = finish?.kind
    if (kind === 'aborted') return '生成已取消'
    if (kind === 'max-tokens') return '输出达到上限，没有产出正文'
    if (kind !== 'error') return '模型没有返回文本'
    const failure = finish?.failure ?? {}
    if (typeof failure.message === 'string' && failure.message.trim() !== '') return failure.message
    if (typeof failure.code === 'string' && failure.code.trim() !== '') return failure.code
    return '未提供失败原因'
  }

  // ---------------------------------------------------------------- 路由

  const askRoute = async (req, res) => {
    let body
    try {
      const raw = await readBody(req)
      body = raw === '' ? {} : JSON.parse(raw)
    } catch (error) {
      sendJson(res, 400, { error: `请求解析失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const question = typeof body?.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION_CHARS) : ''
    if (question === '') {
      sendJson(res, 400, { error: '缺少 question' })
      return
    }

    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      sendJson(res, 503, { error: 'LLM 服务不可用' })
      return
    }

    let session
    if (sessionId !== '') {
      try {
        session = ctx.get('sessions')?.get?.(sessionId)
      } catch {
        session = undefined
      }
    }
    if (session === undefined) {
      sendJson(res, 404, { error: '当前会话不在运行中，无法读取快照' })
      return
    }

    const target = pickModel(session)
    if (target === undefined) {
      sendJson(res, 503, { error: '当前没有可用的模型，请先在主对话里选择一个模型' })
      return
    }

    let transcript = ''
    try {
      transcript = buildTranscript(session)
    } catch (error) {
      sendJson(res, 500, { error: `读取会话快照失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }

    let messages
    try {
      messages = [
        ...buildHistoryTurns(body?.history, target),
        createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } }),
      ]
    } catch (error) {
      sendJson(res, 500, { error: `构造请求失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }

    startEventStream(res)
    const controller = new AbortController()
    let isClosed = false
    const isClosedNow = () => isClosed
    // 浏览器断开（切走、关面板）时立刻掐掉模型流，别继续烧 token
    res.on('close', () => {
      isClosed = true
      controller.abort()
    })

    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)
    let sawText = false
    let finish

    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        sessionId: CALL_IDENTITY,
        messages,
        system: buildSystemPrompt(transcript, session),
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (isClosed) break
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          sawText = true
          sendEvent(res, { type: 'delta', text: chunk.text }, isClosedNow)
          continue
        }
        if (chunk.type === 'finish') finish = chunk.reason
      }
      if (!isClosed) {
        if (sawText) sendEvent(res, { type: 'done' }, isClosedNow)
        else sendEvent(res, { type: 'error', message: noTextReason(finish) }, isClosedNow)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendEvent(res, { type: 'error', message: sawText ? `生成中断：${message}` : message }, isClosedNow)
    } finally {
      clearTimeout(timer)
      if (!isClosed) {
        try {
          res.end()
        } catch {
          /* 已经结束 */
        }
      }
    }
  }

  const pendingRoute = async (req, res) => {
    let sessionId = ''
    let waitMs = PENDING_HOLD_MS
    try {
      const url = new URL(req.url ?? ROUTE_PENDING, 'http://localhost')
      sessionId = url.searchParams.get('sessionId') ?? ''
      const requested = Number(url.searchParams.get('wait'))
      if (Number.isFinite(requested) && requested > 0) waitMs = Math.min(requested, 60000)
    } catch {
      /* 用默认值 */
    }
    if (sessionId === '') {
      sendJson(res, 400, { error: '缺少 sessionId' })
      return
    }
    let question
    try {
      question = await waitForQuestion(sessionId, waitMs)
    } catch {
      question = null
    }
    if (question === null || question === undefined) {
      try {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      } catch {
        /* 已断 */
      }
      return
    }
    sendJson(res, 200, { question })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_ASK, handler: askRoute }),
    'dsh-btw: /dsh-btw/ask route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PENDING, handler: pendingRoute }),
    'dsh-btw: /dsh-btw/pending route',
  )

  /**
   * 兜底路由：浏览器端拿不到 sessionId 时，回一个最近有活动的会话。
   * 只用于「打开面板」时定位会话，不读内容、不改状态。
   */
  const activeRoute = (req, res) => {
    let best = ''
    let bestTime = -1
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) {
        let time = 0
        try {
          const tail = Math.max(0, Number(session.seq) - 1)
          const events = session.snapshotEvents?.(tail) ?? []
          const last = events[events.length - 1]
          if (last !== undefined && typeof last.time === 'number') time = last.time
        } catch {
          time = 0
        }
        if (time > bestTime) {
          bestTime = time
          best = String(session.id ?? '')
        }
      }
    } catch {
      best = ''
    }
    if (best === '') {
      sendJson(res, 404, { error: '当前没有运行中的会话' })
      return
    }
    sendJson(res, 200, { sessionId: best })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_ACTIVE, handler: activeRoute }),
    'dsh-btw: /dsh-btw/active route',
  )

  /**
   * 旁路记忆的读写（同一条路由，按方法分派）：
   *   GET  ?sessionId=…  → { turns }
   *   POST { sessionId, turns } → 整段覆盖（空数组即清空）
   */
  const threadRoute = async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method !== 'POST' && method !== 'PUT') {
      let sessionId = ''
      try {
        const url = new URL(req.url ?? ROUTE_THREAD, 'http://localhost')
        sessionId = url.searchParams.get('sessionId') ?? ''
      } catch {
        sessionId = ''
      }
      if (!validSessionId(sessionId)) {
        sendJson(res, 400, { error: '无效的 sessionId' })
        return
      }
      const turns = await readThread(sessionId)
      sendJson(res, 200, { turns })
      return
    }

    let body
    try {
      const raw = await readBody(req)
      body = raw === '' ? {} : JSON.parse(raw)
    } catch (error) {
      sendJson(res, 400, { error: `请求解析失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!validSessionId(sessionId)) {
      sendJson(res, 400, { error: '无效的 sessionId' })
      return
    }
    await writeThread(sessionId, body?.turns)
    sendJson(res, 200, { ok: true })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_THREAD, handler: threadRoute }),
    'dsh-btw: /dsh-btw/thread route',
  )

  // ---------------------------------------------------------------- /btw 命令

  ctx.effect(() => {
    const commands = ctx.get('commands')
    if (commands === undefined || typeof commands.register !== 'function') return () => {}
    return commands.register({
      name: 'btw',
      description: '旁路问答：主对话继续运行时，在输入框上方的抽屉里只读提问，不打断对话、不写入会话',
      input: { hint: '要问旁路的问题（留空则只打开抽屉）' },
      handler: (invocation) => {
        const sessionId = String(invocation?.agent?.id ?? '')
        if (sessionId === '') return { kind: 'error', text: '无法确定当前会话' }
        const raw = String(invocation?.rawInput ?? '').trim()
        const question = raw.replace(/^\/?btw\b/i, '').trim()
        enqueue(sessionId, question)
        return {
          kind: 'success',
          text: question === '' ? '已打开旁路问答' : '已把问题转到旁路问答',
        }
      },
    })
  }, 'dsh-btw: /btw command')

  // 卸载时放掉挂起的长轮询，避免请求悬着
  ctx.effect(() => () => {
    releaseWaiters()
    queued.clear()
  }, 'dsh-btw: release waiters')
}
