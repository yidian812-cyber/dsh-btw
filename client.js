/**
 * dsh-btw —— 旁路问答（浏览器半侧）
 *
 * 形态：右侧**让位式**停靠面板。
 *  - 打开时给 AppFrame 加一条与面板同宽的 `padding-right`（CSS `:has()` 选中帧元素），
 *    三列 grid 因此整体收窄，主对话列真的让出那块空间 —— 面板不是浮在上面，而是"占住"它；
 *  - 面板绝对定位在帧的右边缘、全高，拖左边缘即可调整宽度（记在 localStorage）；
 *  - 内置右侧栏（文件/终端）仍能正常打开，会出现在旁路的**左边**。
 *
 * 为什么不用 `rightbar` 槽位：那是 single 槽位且被内置右侧栏占着；覆盖它要么没反应、
 * 要么把内置侧边栏顶掉。给帧加留白能同时保住两者。
 *
 * 面板与主对话完全解耦：它不写 session、不调工具，只把问题发给 Host 半侧换取文本。
 */

window.__ModuleLoader__.load({
  id: 'dsh-btw',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE_ASK = '/dsh-btw/ask';
    const ROUTE_PENDING = '/dsh-btw/pending';
    const ROUTE_ACTIVE = '/dsh-btw/active';
    const WIDTH_KEY = 'dsh-btw:width';
    const ROUTE_THREAD = '/dsh-btw/thread';
    const MAX_PERSISTED_TURNS = 80;
    const MIN_WIDTH = 280;
    const MAX_WIDTH = 820;

    // ------------------------------------------------------------ 极简 store

    let state = {
      open: false,
      sessionId: null,
      turns: [],
      streaming: false,
      error: null,
      width: 400,
    };
    const listeners = new Set();

    function setState(patch) {
      state = Object.assign({}, state, patch);
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          /* 单个订阅者出错不影响其它 */
        }
      }
    }
    function subscribe(listener) {
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    }
    function getSnapshot() {
      return state;
    }
    function useStore() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // ------------------------------------------------------------ 宽度

    function clampWidth(px) {
      const viewport = window.innerWidth || 1440;
      const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(viewport * 0.6)));
      return Math.min(max, Math.max(MIN_WIDTH, Math.round(px)));
    }

    function loadWidth() {
      try {
        const raw = window.localStorage.getItem(WIDTH_KEY);
        if (raw !== null) {
          const parsed = Number(raw);
          if (isFinite(parsed) && parsed > 0) return clampWidth(parsed);
        }
      } catch (error) {
        /* 用默认值 */
      }
      return clampWidth(400);
    }

    function saveWidth(width) {
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch (error) {
        /* 存不下只影响下次 */
      }
    }

    // ------------------------------------------------------------ 会话内保留的问答记录（存在 Host 侧，重启也在）

    const threadCache = new Map();
    const threadLoading = new Map();

    function sanitizeTurns(value) {
      if (!Array.isArray(value)) return [];
      const clean = [];
      for (const turn of value) {
        if (!turn || typeof turn !== 'object') continue;
        const role = turn.role === 'user' ? 'user' : turn.role === 'assistant' ? 'assistant' : null;
        if (role === null) continue;
        if (typeof turn.text !== 'string' || turn.text === '') continue;
        clean.push({ role: role, text: turn.text });
      }
      return clean.slice(-MAX_PERSISTED_TURNS);
    }

    /** 读入某会话的旁路记录（进程内缓存 + Host 侧文件）。 */
    function ensureThread(sessionId) {
      if (!sessionId) return Promise.resolve([]);
      if (threadCache.has(sessionId)) return Promise.resolve(threadCache.get(sessionId));
      if (threadLoading.has(sessionId)) return threadLoading.get(sessionId);
      const task = fetch(ROUTE_THREAD + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) return [];
          return response.json().then(function (payload) {
            return sanitizeTurns(payload && payload.turns);
          });
        })
        .catch(function () {
          return [];
        })
        .then(function (turns) {
          threadCache.set(sessionId, turns);
          threadLoading.delete(sessionId);
          return turns;
        });
      threadLoading.set(sessionId, task);
      return task;
    }

    /** 整段覆盖写回（空数组即清空）。 */
    function persistThread(sessionId, turns) {
      if (!sessionId) return;
      const clean = sanitizeTurns(turns);
      threadCache.set(sessionId, clean);
      fetch(ROUTE_THREAD, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, turns: clean }),
      }).catch(function () {
        /* 写盘失败时页面内这份仍然可用 */
      });
    }

    /** 更新线程并落盘（按会话存，关面板、刷新、应用重启都不丢）。 */
    function commitTurns(turns) {
      const clean = sanitizeTurns(turns);
      setState({ turns: clean });
      persistThread(state.sessionId, clean);
    }

    // ------------------------------------------------------------ 行为

    let controller = null;

    function describeError(error) {
      if (error instanceof Error) return error.message;
      return String(error);
    }

    function abortStream() {
      if (controller === null) return;
      try {
        controller.abort();
      } catch (error) {
        /* 已结束 */
      }
      controller = null;
    }

    function patchLast(turns, text, pending) {
      const next = turns.slice();
      const last = next[next.length - 1];
      if (!last || last.role !== 'assistant') return turns;
      next[next.length - 1] = { role: 'assistant', text: text, pending: pending === true };
      return next;
    }

    function settleLast(turns, text) {
      const next = turns.slice();
      const last = next[next.length - 1];
      if (!last || last.role !== 'assistant') return turns;
      const all = (text || last.text || '').trim();
      if (all === '') return next.slice(0, -1);
      next[next.length - 1] = { role: 'assistant', text: text === '' ? last.text : text, pending: false };
      return next;
    }

    function openPanel(sessionId) {
      const bound = sessionId || null;
      const keep = state.open && state.sessionId === bound;
      setState({
        open: true,
        sessionId: bound,
        turns: keep ? state.turns : (bound ? threadCache.get(bound) || [] : []),
        error: null,
        width: loadWidth(),
      });
      if (bound) {
        void ensureThread(bound).then(function (turns) {
          if (state.open && state.sessionId === bound && state.turns.length === 0 && turns.length > 0) {
            setState({ turns: turns });
          }
        });
      }
    }

    /** 清空当前会话的旁路记录（面板上的「清空」）。 */
    function clearThread() {
      abortStream();
      setState({ turns: [], streaming: false, error: null });
      persistThread(state.sessionId, []);
    }

    function closePanel() {
      abortStream();
      setState({ open: false, streaming: false });
    }

    function stopStreaming() {
      abortStream();
    }

    /** 槽位没给 sessionId 时的兜底：让 Host 报一个最近有活动的会话。 */
    async function resolveSessionId(sessionId) {
      if (sessionId) return sessionId;
      try {
        const response = await fetch(ROUTE_ACTIVE, { cache: 'no-store' });
        if (!response.ok) return '';
        const payload = await response.json();
        if (payload && typeof payload.sessionId === 'string') return payload.sessionId;
      } catch (error) {
        /* 交给上层报错 */
      }
      return '';
    }

    async function ask(sessionId, question) {
      const text = String(question || '').trim();
      if (text === '' || state.streaming) return;

      // 先把这段旁路的旧记录读进来（本地几毫秒），连续追问他才接得上
      let bound = sessionId || state.sessionId || '';
      if (!bound) bound = await resolveSessionId('');
      if (!bound) {
        setState({ error: '找不到可读的会话：请先打开一个会话再问' });
        return;
      }
      if (state.turns.length === 0) {
        const prior = await ensureThread(bound);
        if (state.turns.length === 0 && prior.length > 0) setState({ turns: prior });
      }
      if (bound !== state.sessionId) setState({ sessionId: bound });

      const history = [];
      for (const turn of state.turns) {
        if (typeof turn.text === 'string' && turn.text.trim() !== '') {
          history.push({ role: turn.role, text: turn.text });
        }
      }
      const turns = state.turns.concat([
        { role: 'user', text: text },
        { role: 'assistant', text: '', pending: true },
      ]);
      setState({ turns: turns, streaming: true, error: null });

      const local = new AbortController();
      controller = local;
      let answer = '';

      try {
        const response = await fetch(ROUTE_ASK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: bound, question: text, history: history }),
          signal: local.signal,
        });
        if (!response.ok) {
          let message = 'HTTP ' + response.status;
          try {
            const payload = await response.json();
            if (payload && typeof payload.error === 'string') message = payload.error;
          } catch (error) {
            /* 保持状态码文案 */
          }
          throw new Error(message);
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          throw new Error('当前环境不支持流式响应');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let failure = null;

        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = frame.split('\n');
            for (const line of lines) {
              if (line.indexOf('data:') !== 0) continue;
              const raw = line.slice(5).trim();
              if (raw === '') continue;
              let event;
              try {
                event = JSON.parse(raw);
              } catch (error) {
                continue;
              }
              if (event.type === 'delta' && typeof event.text === 'string') {
                answer += event.text;
                setState({ turns: patchLast(state.turns, answer, true) });
              } else if (event.type === 'error') {
                failure = typeof event.message === 'string' ? event.message : '生成失败';
              }
            }
            split = buffer.indexOf('\n\n');
          }
        }

        if (failure !== null) throw new Error(failure);
      } catch (error) {
        const aborted = error && error.name === 'AbortError';
        if (!aborted) setState({ error: describeError(error) });
      } finally {
        controller = null;
        setState({ streaming: false });
        commitTurns(settleLast(state.turns, answer));
      }
    }

    /** 长轮询 `/btw` 命令投递的问题；面板关闭时也在跑，所以命令能瞬间把面板顶出来。 */
    function startPendingLoop(sessionId) {
      let cancelled = false;
      let active = null;

      function sleep(ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms);
        });
      }

      (async function run() {
        while (!cancelled) {
          try {
            active = new AbortController();
            const response = await fetch(
              ROUTE_PENDING + '?sessionId=' + encodeURIComponent(sessionId) + '&wait=20000',
              { signal: active.signal, cache: 'no-store' },
            );
            if (cancelled) return;
            if (response.status === 200) {
              let payload = null;
              try {
                payload = await response.json();
              } catch (error) {
                payload = null;
              }
              if (payload && typeof payload.question === 'string') {
                openPanel(sessionId);
                if (payload.question.trim() !== '') void ask(sessionId, payload.question);
              }
              continue;
            }
            if (response.status !== 204) await sleep(3000);
          } catch (error) {
            if (cancelled) return;
            await sleep(3000);
          }
        }
      })();

      return function stop() {
        cancelled = true;
        if (active) {
          try {
            active.abort();
          } catch (error) {
            /* 已结束 */
          }
        }
      };
    }

    // ------------------------------------------------------------ 图标

    function icon(size) {
      const px = size || 14;
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M2 4.2C2 3 2.9 2 4.1 2h5.3c1.2 0 2.1 1 2.1 2.2v2.6c0 1.2-.9 2.2-2.1 2.2H6.2L4 11V9H4.1C2.9 9 2 8 2 6.8z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.2 6.4h.4c1 0 1.9.9 1.9 1.9v1.9c0 1-.9 1.9-1.9 1.9h-.2v1.6l-1.9-1.6h-1.9c-1 0-1.9-.9-1.9-1.9',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
      );
    }

    // ------------------------------------------------------------ 样式

    const CSS = [
      '.dsh-btw-toggle{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:1;',
      'white-space:nowrap;}',
      '.dsh-btw-toggle:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}',
      '.dsh-btw-toggle.is-active{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-btw-root{position:absolute;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;',
      'display:flex;flex-direction:column;pointer-events:auto;z-index:30;font-family:inherit;font-size:13px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-fill);',
      'border-left:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-btw-resizer{position:absolute;left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:2;',
      'background:transparent;border:none;padding:0;}',
      '.dsh-btw-resizer:hover{background:var(--dsw-alias-border-l2);opacity:.45;}',
      '.dsh-btw-resizer[data-dragging]{background:var(--dsw-alias-brand-primary);opacity:.45;}',
      '.dsh-btw-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 12px;flex:none;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-btw-title{font-size:12.5px;font-weight:600;flex:none;}',
      '.dsh-btw-sub{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1 1 auto;min-width:0;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-btw-clearthread{flex:none;border:none;border-radius:6px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:1;padding:4px 6px;}',
      '.dsh-btw-clearthread:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-btw-close{margin-left:2px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;',
      'border:none;border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);',
      'font-size:15px;line-height:1;padding:0;}',
      '.dsh-btw-close:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-btw-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;',
      'flex-direction:column;gap:8px;}',
      '.dsh-btw-turn{display:flex;}',
      '.dsh-btw-turn.user{justify-content:flex-end;}',
      '.dsh-btw-bubble{max-width:86%;padding:7px 11px;border-radius:11px;line-height:1.65;',
      'white-space:pre-wrap;word-break:break-word;font-size:13px;}',
      '.dsh-btw-turn.user .dsh-btw-bubble{background:var(--dsw-alias-brand-primary);color:#fff;',
      'border-bottom-right-radius:4px;}',
      '.dsh-btw-turn.assistant .dsh-btw-bubble{background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l1);border-bottom-left-radius:4px;}',
      '.dsh-btw-empty{margin:auto;padding:6px 4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8;}',
      '.dsh-btw-empty strong{display:block;color:var(--dsw-alias-label-primary);font-size:12.5px;margin-bottom:4px;}',
      '.dsh-btw-error{margin:0 12px 8px;padding:6px 9px;border-radius:8px;font-size:12px;line-height:1.5;',
      'color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-btw-compose{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px 9px;flex:none;',
      'display:flex;flex-direction:column;gap:6px;}',
      '.dsh-btw-input{width:100%;box-sizing:border-box;resize:none;font-family:inherit;font-size:13px;',
      'line-height:1.55;padding:7px 10px;border-radius:9px;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);outline:none;}',
      '.dsh-btw-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-btw-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.dsh-btw-actions{display:flex;align-items:center;gap:8px;}',
      '.dsh-btw-hint{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-btw-send{flex:none;border:none;border-radius:8px;padding:5px 13px;font-family:inherit;',
      'font-size:12.5px;cursor:pointer;background:var(--dsw-alias-brand-primary);color:#fff;}',
      '.dsh-btw-send:disabled{opacity:.45;cursor:default;}',
      '.dsh-btw-send.is-stop{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l2);}',
      '.dsh-btw-caret{display:inline-block;width:2px;height:13px;margin-left:2px;vertical-align:-2px;',
      'background:var(--dsw-alias-brand-primary);animation:dsh-btw-blink 1s steps(2,start) infinite;}',
      '.dsh-btw-thinking{color:var(--dsw-alias-label-secondary);}',
      '@keyframes dsh-btw-blink{to{visibility:hidden;}}',
    ].join('');

    /**
     * 让位规则：面板挂着 `.dsh-btw-reserve` 时，给帧加同宽的右内边距。
     * 选择器不依赖 hashed class —— 用 `:has(> [data-shell-overlay])` 找"那个帧元素"
     *（overlay 层是帧的直接子节点）；同时保留 hashed class 作为后备。
     */
    function reserveCss(width) {
      return [
        'body:has(.dsh-btw-reserve) .BynINW_frame,',
        'body:has(.dsh-btw-reserve) *:has(> [data-shell-overlay]){',
        'box-sizing:border-box;padding-right:' + width + 'px;}',
      ].join('');
    }

    // ------------------------------------------------------------ 会话 id

    // 会话作用域槽位会把 sessionId 作为 props 传下来；这里对几种可能形态都兜一下
    function sessionIdOf(props) {
      if (!props || typeof props !== 'object') return '';
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId;
      const session = props.session;
      if (session && typeof session === 'object') {
        if (typeof session.id === 'string' && session.id !== '') return session.id;
        if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId;
        if (session.header && typeof session.header.id === 'string') return session.header.id;
      }
      return '';
    }

    // ------------------------------------------------------------ 开关按钮

    function BtwToggle(props) {
      const sessionId = sessionIdOf(props);
      const snapshot = useStore();

      React.useEffect(
        function () {
          if (sessionId === '') return undefined;
          return startPendingLoop(sessionId);
        },
        [sessionId],
      );

      const active = snapshot.open;
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            className: 'dsh-btw-toggle' + (active ? ' is-active' : ''),
            title: '旁路问答（/btw）：不打断当前对话的只读提问',
            'aria-label': '旁路问答',
            'aria-pressed': active,
            onClick: function () {
              if (active) closePanel();
              else openPanel(sessionId);
            },
          },
          icon(14),
          h('span', null, '旁路'),
        ),
      );
    }

    // ------------------------------------------------------------ 停靠面板

    function BtwPanel() {
      const snapshot = useStore();
      const [draft, setDraft] = React.useState('');
      const [dragging, setDragging] = React.useState(false);
      const listRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const widthRef = React.useRef(snapshot.width);
      widthRef.current = snapshot.width;

      React.useEffect(
        function () {
          if (!snapshot.open) return undefined;
          const timer = setTimeout(function () {
            if (inputRef.current) inputRef.current.focus();
          }, 40);
          return function () {
            clearTimeout(timer);
          };
        },
        [snapshot.open],
      );

      React.useEffect(
        function () {
          const element = listRef.current;
          if (element) element.scrollTop = element.scrollHeight;
        },
        [snapshot.turns, snapshot.open],
      );

      if (!snapshot.open) return null;

      const sessionId = snapshot.sessionId || '';
      const streaming = snapshot.streaming;
      const width = snapshot.width;

      function beginResize(event) {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const base = widthRef.current;
        setDragging(true);
        function move(moveEvent) {
          setState({ width: clampWidth(base - (moveEvent.clientX - startX)) });
        }
        function finish() {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          setDragging(false);
          saveWidth(widthRef.current);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
      }

      function submit() {
        const text = draft.trim();
        if (text === '' || streaming) return;
        setDraft('');
        void ask(sessionId, text);
      }

      function onKeyDown(event) {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (event.nativeEvent && event.nativeEvent.isComposing) return;
        event.preventDefault();
        submit();
      }

      const rows = snapshot.turns.map(function (turn, index) {
        const isUser = turn.role === 'user';
        const pending = turn.pending === true;
        const children = [];
        if (turn.text !== '') children.push(turn.text);
        if (!isUser && pending) {
          if (turn.text === '') {
            children.push(h('span', { key: 'wait', className: 'dsh-btw-thinking' }, '思考中…'));
          } else {
            children.push(h('span', { key: 'caret', className: 'dsh-btw-caret' }));
          }
        }
        return h(
          'div',
          { key: 'turn-' + String(index), className: 'dsh-btw-turn ' + (isUser ? 'user' : 'assistant') },
          h('div', { className: 'dsh-btw-bubble' }, children),
        );
      });

      const body =
        rows.length === 0
          ? h(
              'div',
              { className: 'dsh-btw-empty' },
              h('strong', null, '主对话照常运行，这里不会打断它。'),
              h('div', null, '它能读到当前会话的快照，但不能改任何东西，也不能调用工具。'),
              h('div', { style: { marginTop: '8px', opacity: 0.8 } }, '关掉面板再打开，这段问答还在。'),
            )
          : rows;

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS + reserveCss(width)),
        h(
          'div',
          { className: 'dsh-btw-root dsh-btw-reserve', key: 'panel', style: { width: width + 'px' } },
          h('button', {
            type: 'button',
            className: 'dsh-btw-resizer',
            'aria-label': '拖动调整旁路宽度',
            title: '拖动调整宽度',
            'data-dragging': dragging || undefined,
            onPointerDown: beginResize,
          }),
          h(
            'div',
            { className: 'dsh-btw-head' },
            icon(13),
            h('div', { className: 'dsh-btw-title' }, '旁路问答'),
            h('div', { className: 'dsh-btw-sub' }, '只读 · 记录按会话保留'),
            h(
              'button',
              { type: 'button', className: 'dsh-btw-clearthread', title: '清空这段问答记录', onClick: clearThread },
              '清空',
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-btw-close', title: '关闭', 'aria-label': '关闭旁路问答', onClick: closePanel },
              '×',
            ),
          ),
          h('div', { className: 'dsh-btw-list', ref: listRef }, body),
          snapshot.error !== null ? h('div', { className: 'dsh-btw-error' }, String(snapshot.error)) : null,
          h(
            'div',
            { className: 'dsh-btw-compose' },
            h('textarea', {
              ref: inputRef,
              className: 'dsh-btw-input',
              rows: 3,
              value: draft,
              placeholder: '在这里提问，回车发送，Shift+回车换行…',
              onChange: function (event) {
                setDraft(event.target.value);
              },
              onKeyDown: onKeyDown,
            }),
            h(
              'div',
              { className: 'dsh-btw-actions' },
              h('div', { className: 'dsh-btw-hint' }, 'Enter 发送 · 拖左边缘调宽'),
              streaming
                ? h('button', { type: 'button', className: 'dsh-btw-send is-stop', onClick: stopStreaming }, '停止')
                : h(
                    'button',
                    { type: 'button', className: 'dsh-btw-send', disabled: draft.trim() === '', onClick: submit },
                    '发送',
                  ),
            ),
          ),
        ),
      );
    }

    // ------------------------------------------------------------ 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-btw-panel', order: 900 }, function () {
            return h(BtwPanel, {});
          });
        });

        ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-btw-toggle', order: 5 },
            function (props) {
              return h(BtwToggle, props || {});
            },
          );
        });
      },
    };
  },
});
