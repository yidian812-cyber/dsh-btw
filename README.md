# dsh-btw

**By The Way** —— 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一个只读的右侧问答面板。

主对话还在跑、还在等工具的时候，你想顺口问一句「它现在在做什么」「刚才那个报错什么原因」，又不想打断它、更不想把这段问答塞进主对话的上下文——按一下「旁路」，在右边问，答案流式返回，主对话不受任何影响。

这个交互仿照 Claude Code 的 `/btw` 功能：主任务继续运行时插一句话，不打断它，也不进入主对话历史。这里把它做成了 DSH 的右侧停靠面板。

> A read-only side channel for DeepSeek Harness: ask questions in a docked right-hand panel while the main conversation keeps running. It never writes to the session and cannot call tools. Inspired by Claude Code's `/btw`.

## 它不做什么

- 不向主会话追加任何事件（不占主对话上下文、不改主对话）
- 不注册、不调用任何工具
- 不唤醒、不打断正在运行的 Agent

## 安装

这是一个标准的 DSH bundle 包（`package.json` 里声明了 `dsh.bundle.patch`，并带一个 Web 客户端半侧）。在插件管理的「安装 bundle」里指向下面任一来源即可：

| 来源 | 目标 |
| --- | --- |
| Git 仓库（推荐） | `git+https://github.com/yidian812-cyber/dsh-btw.git` |
| 本地目录 | 本仓库根目录 |
| `npm pack` 产物 | `yidian812-cyber-dsh-btw-0.1.0.tgz` |

> 本项目不发布到 npm；包名带 scope（`@yidian812-cyber/dsh-btw`）是因为 npm 上的 `dsh-btw` 已被另一位作者的插件占用，留着 scope 可以避免两者混在一起。

也可以走命令行（底层同样是把包装进 profile 并登记进 bundle 层）：

```bash
dsh plugin --profile <profile> add git+https://github.com/yidian812-cyber/dsh-btw.git
```

装好后：新装 bundle 一般热生效；**换包（改名、升级）要完全退出并重开 DSH**——Host 半侧只在宿主启动时加载，前端模块刷新页面即可。

## 用法

| 入口 | 行为 |
| --- | --- |
| 输入框工具栏里的「旁路」按钮 | 打开／关闭面板（打开时按钮高亮） |
| `/btw` | 打开面板，光标落在面板输入框 |
| `/btw 为什么刚才那个测试挂了？` | 打开面板并把问题直接发出去 |

- 面板里**回车发送**、**Shift+回车换行**，回答流式返回，生成中可以「停止」。
- 拖面板**左边缘**调宽度（280 ～ min(820, 窗口宽×60%)），宽度会被记住。
- 问答记录**按会话保留**：关面板、刷新页面、重启应用都还在；右上角「清空」只清当前会话的这段记录。

## 工作原理

### 1. 只读快照，而不是接管主对话

每次提问时，宿主半侧：

1. 用 `session.deriveMessages()`（模型真正看到的那份历史）压平成文本：用户消息、助手正文、工具调用名；工具结果只留前 600 字；
2. 截到最近 16000 字符；
3. 把快照放进 system prompt，明确声明「只读、不能调工具、不能改主对话」；
4. 用该会话上一次请求所用的 provider/model 直接调 `ctx.llm.stream`（拿不到就回落到全局默认模型）。

**主对话的 token 一分不涨**；旁路自己的输入上限由上面两个数字控制。

### 2. 旁路自己的记忆

旁路不是"每次都失忆"：它和你在侧栏里最近几轮问答会作为对话历史一并发给模型（最近 12 条、单条 ≤3000 字、总计 ≤8000 字），所以连续追问接得上。

但事实来源始终是**主对话快照**——提示词里写明：之前的说法若与快照冲突，以快照为准并说明。

记录按会话落在宿主侧：

```
<DSH_HOME>/btw-threads/<sessionId>.json
```

先写 `.tmp` 再 `rename`，每个会话一个文件，最多 200 条消息／单条 2 万字。

### 3. 右侧让位，而不是浮层

DSH 的右侧栏是一条被内置侧边栏占用的 single 槽位，插件无法安全地"再加一列"。所以本插件走的是给帧加内边距：

```css
body:has(.dsh-btw-reserve) *:has(> [data-shell-overlay]) {
  box-sizing: border-box;
  padding-right: <面板宽度>px;
}
```

三列 grid 因此整体收窄，中间对话列真的让出那块空间，面板绝对定位在帧的右边缘、正好铺在留白上。关闭面板 → 样式随组件卸载 → 帧恢复。

兜底：面板挂载后会自检几何尺寸，一旦测到被挤出可视区或被压成 0 尺寸（宿主改类名、改 DOM 时的典型后果），就切成 `position: fixed` 浮层盖在内容上——宁可挡住一部分，也不会整块消失。

副作用：内置右侧栏（文件 / 终端 / 浏览器）仍然可用，会出现在**旁路的左边**。

## 目录结构

```
index.js          Host 半侧：HTTP 路由 + /btw 命令 + 快照/模型调用/记忆落盘
client.js         浏览器半侧：工具栏按钮 + 停靠面板 + 让位样式（React，无构建）
cordis.patch.yml  bundle 挂载声明
locale/{en,zh}.json  插件管理页的标题与描述
icon.svg          插件图标
```

宿主半侧提供三条路由（同源，仅本机）：

| 路由 | 用途 |
| --- | --- |
| `POST /dsh-btw/ask` | 提问 → SSE 文本增量 |
| `GET /dsh-btw/pending` | 长轮询，`/btw` 命令把问题投递给页面 |
| `GET/POST /dsh-btw/thread` | 读/写当前会话的旁路记录 |
| `GET /dsh-btw/active` | 兜底：定位最近有活动的会话 |

## 限制

- 旁路看不到快照之外的东西，也不能执行任何操作；让它「去改文件」它只会说这得回主对话做。
- 会话必须处于运行中（宿主 `ctx.sessions` 里有它）；冷会话读不到快照。
- 让位样式依赖宿主帧的 DOM 结构（`[data-shell-overlay]` 是帧的直接子节点）。宿主大改版时让位可能失效，此时面板退化成右侧浮层（见上）。
- 旁路在右、内置侧边栏在它左边（与"侧边栏永远最右"的偏好相反）。
- 界面文案走客户端 locale 服务：内置中文、英文，其它语言回退英文；Host 半侧返回的错误信息仍是中文。

## 开发

无构建、无依赖：两个原生 ESM 文件。CI 做语法检查、客户端模块冒烟测试和 `npm pack --dry-run`。

```bash
node --check index.js
node --check client.js
node test/smoke-client.cjs   # 模块 id / inject / locale 字典 / 两个 slot 注册
npm pack --dry-run
```

## License

[MIT](LICENSE)
