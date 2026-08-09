# Ask Codex

[English](README.en.md) | 简体中文

Ask Codex 是一个本地优先的 Codex 浏览器客户端。它通过官方
`codex app-server` 协议工作，不包装终端界面，也不修改 Codex 桌面应用。

```text
浏览器界面  <->  Ask Codex 网关  <->  codex app-server  <->  你的工作区
                WebSocket          基于标准输入输出的 JSONL
```

网关将 Codex 进程和本地凭据保留在宿主机上。浏览器可以接收会话、轮次、工具、
命令、差异和审批事件的流式更新，但不提供接受任意路径的通用文件服务接口。

## 功能

- 创建、搜索、恢复和刷新 Codex 会话；Active/Archived 视图按工作目录分组，各组内的
  置顶会话排在其他会话之前。第三个只读 Activity 标签集中显示跨线程的待审批、待输入、
  运行中和近期状态；查看该目录不会在后台恢复或认领线程，只有点击条目才进入对应会话。
- 通过桌面端右键、移动端长按或 `...` 菜单重命名、置顶或取消置顶会话，也可归档
  Active 视图中的空闲会话、恢复 Archived 视图中的会话，或经二次确认永久删除任一视图
  中的空闲会话。正在执行轮次时仍可重命名和调整置顶状态，但不会开放归档和删除操作。
- 第四个只读 Skills 标签按工作目录展示官方 `skills/list` 返回的名称、描述、作用域和
  启用状态。首次打开标签时才加载目录；手动刷新会要求 Codex 跳过缓存重新扫描，
  `skills/changed` 通知也会刷新已经打开过的目录。网关严格重建请求参数，并从响应中
  只扁平保留 `interface.shortDescription`，剥离 skill 路径、依赖、其余 interface
  元数据和具体错误文本。
- 增量加载长会话历史；默认历史保留有界降级处理，已有分页历史可按条目恢复超大轮次。
- 流式展示 Agent 消息、推理摘要、计划、命令输出、文件变更、MCP 调用和轮次差异；连续且
  有内容的历史推理会在原位置合并并可展开，进行中轮次底部则保留固定的推理状态槽，推理
  活跃时显示动画，空闲时显示灰态。执行中的结构化计划会在输入区上方提供紧凑的可展开进度，
  轮次差异则明确标记为整轮变更汇总。
- 展示带复制与换行控制的语法高亮代码块、统一或分栏差异，以及分组、可折叠且输出有界的
  工具活动。连续且已正式支持的机器活动组成零间距、仅由单条横线分隔的活动栈，包括命令、
  文件变更、MCP 调用、搜索、动态工具、subagent/collab，以及图片查看和生成。
- 在浏览器中审核命令与文件变更请求，并在本次浏览器会话中把审批理由保留在对应命令上。
- 每个轮次默认手动审批；已有空闲线程或已完成配置的新会话草稿可为下一次直接轮次临时开启
  免审批提示模式。Working 时开关禁用，轮次结束或启动失败后自动恢复手动，下一轮必须重新
  显式开启。新线程创建、恢复、跨设备队列和 steering 始终使用手动策略；只有首个独立
  `turn/start` 可采用草稿上的当次选择。`never` 不会放宽沙箱限制，也不依赖实验性设置 API。
- 回答 `request_user_input` 发出的结构化问题。
- 新建会话时选择绝对工作目录和沙箱，并在输入框旁选择下一轮使用的模型与推理强度。
  工作目录默认继承当前选中会话的 `cwd`；没有选中会话时使用 `ASK_CODEX_WORKSPACE`。
  新会话的初始沙箱始终是 `workspace-write`。初始模型和推理强度来自 Codex 的有效配置，
  其他选项来自 `model/list`。
- 从工具栏打开只读 Usage 面板，查看当前线程 token、最近上下文占用、账户活动和速率
  限制窗口。账户数据来自严格允许并投影的 `account/usage/read` 与
  `account/rateLimits/read`；不支持这些接口的登录方式会显示 unavailable，而不会把它
  误报为账单或美元成本。滚动更新不会被较旧的读取结果覆盖，面板也会明确标出已触及的
  速率或消费上限。
- 工具栏区分连接、自动重试次数和重同步状态，并允许立即重试；Codex 子进程错误通过有界
  只读探测触发重启，WebSocket 断线则重建连接。恢复后，当前线程通过只读快照重新同步；
  同步完成前禁止发送，同步失败则保持阻塞并提供只读重试，但不会重放未确认的写请求，
  也不会通过后台 `thread/resume` 改变审批路由。
- 轮次运行、断线或重同步期间仍可继续编辑文字草稿；回车只换行，可点击发送按钮或按
  `Ctrl+Enter` 发送，macOS 同时支持 `Cmd+Enter`。未确认成功的发送与新输入分开保留，
  避免异步失败覆盖正在编辑的内容。
- 将已有线程的纯文本加入服务端持久消息队列，并在另一台已认证设备上显式发送或取消。
  队列不会在重连、启动或线程忙碌时自动执行，也不会转换为 steering；发送前会核对线程
  状态与最后轮次。写入结果不确定的项目只能在核对原生历史后移除，绝不自动重放。
- 选择或粘贴 PNG、JPEG、WebP 图片，预览后随文本或单独发送；发送成功后，浏览器会在
  本地有界保留可点开的缩略图。同一浏览器配置文件通过同一 Origin 可在页面或线程重载
  以及浏览器重启后恢复仍有效的预览；本地副本默认保留 30 天，最多 8 张、共 40 MiB。
  清除站点数据、浏览器回收存储，或换用其他设备、浏览器、配置文件或 Origin 后，历史
  图片会回退为不暴露路径的安全占位符。服务端临时上传的数量、大小和生命周期仍受网关
  限制，图片二进制不会进入 WebSocket JSON。
- 已完成 Agent 消息中的显式绝对本地文件链接，在指向 app-server 权威 `thread.cwd`
  范围内的普通文件时，可经链接内二次确认下载。网关只签发短期、一次性、不透明的
  capability，不接受浏览器提供的路径。不存在 `ASK_CODEX_DOWNLOAD_ROOTS`，也不设置全局
  下载根目录。该能力不能列出目录、读取任意路径或预览文件，不是通用文件服务。
- 中断正在执行的轮次。
- 支持桌面端与移动端响应式布局。
- 支持可选的网页访问令牌、Origin 检查，并默认仅监听回环地址。

## 界面截图

### 桌面端

![Ask Codex 桌面端界面](docs/screenshots/desktop.png)

### 移动端

<img src="docs/screenshots/mobile.png" alt="Ask Codex 移动端界面" width="390">

## 环境要求

- Node.js 22.12 或更高版本。
- 支持有文档记录的 app-server 接口的较新 Codex CLI；当前实现已使用 0.147.0 验证。
- 已完成 Codex 登录；如尚未登录，请先运行 `codex login`。

app-server 自带的 WebSocket 传输仍属于实验功能。Ask Codex 在自己的浏览器网关后
使用更成熟的 JSONL-over-stdio 传输。

## 开发

```bash
git clone https://github.com/zlotus/ask-codex.git
cd ask-codex
npm install
ASK_CODEX_WORKSPACE=/absolute/path/to/project npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 提供前端页面，并将 API 和 WebSocket
流量代理到 `127.0.0.1:4173` 上的网关。

## 生产运行

```bash
npm run build
ASK_CODEX_WORKSPACE=/absolute/path/to/project npm start
```

打开 `http://127.0.0.1:4173`。

配置项：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ASK_CODEX_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `ASK_CODEX_PORT` | `4173` | 网关端口 |
| `ASK_CODEX_WORKSPACE` | 服务进程的工作目录 | Codex 初始绝对工作目录 |
| `ASK_CODEX_TOKEN` | 未设置 | 浏览器访问令牌；监听非回环地址时必须设置 |
| `ASK_CODEX_PUBLIC_ORIGIN` | 未设置 | 允许可信反向代理转发的唯一外部 Origin；设置后必须同时设置 `ASK_CODEX_TOKEN` |
| `ASK_CODEX_QUEUE_PATH` | `$XDG_STATE_HOME/ask-codex/message-queue.json`，未设置 XDG 时为 `~/.local/state/ask-codex/message-queue.json` | 跨设备纯文本消息队列的绝对 JSON 文件路径；只能由一个网关进程使用 |
| `CODEX_BIN` | `codex` | Codex CLI 可执行文件 |

消息队列以运行 Ask Codex 的操作系统账户权限保存明文，目录和文件分别创建为 `0700` 与
`0600`。它不保存 token、附件、路径或审批内容；两个网关进程不得共享同一个队列文件。

## 远程访问

不要将本服务直接暴露到公网。任何可以使用该界面的人都可以指示 Codex 读取文件、
修改所选工作区、运行命令、提出扩大访问权限的请求，还可以不经 Codex 审批永久删除
线程及其可能的后代会话。

请把 `ASK_CODEX_TOKEN` 当作运行 Ask Codex 的操作系统账户密码。
`ASK_CODEX_WORKSPACE` 只负责选择初始目录，并不是访问边界。通过认证的浏览器可以
在新建会话时选择其他绝对目录，也可以在经过 Codex 审批后选择完全访问沙箱模式。
`thread.cwd=/` 会为受限文件下载形成非常宽的候选范围。通过 Origin、Host 和 token
认证后，单个下载仅依赖服务端签发的短期、一次性 opaque capability；应将 capability
作为临时凭据保护，不要把它当作持久权限。

需要从其他设备访问时：

1. 设置一个足够长的随机 `ASK_CODEX_TOKEN`。
2. 使用 `ASK_CODEX_HOST` 监听私有网络接口。
3. 将服务置于 TLS 和带认证的反向代理、VPN 或 SSH 隧道之后。
4. 确保代理与应用日志不会记录 Authorization 请求头或 WebSocket 消息体。
5. 保持 Codex 沙箱开启，并检查每次提权请求中的工作目录和会话级权限详情。

未设置令牌时，服务会拒绝监听非回环地址。本工具面向单用户；令牌只是访问门禁，
不提供多用户隔离或基于角色的权限控制。

### Cloudflare Tunnel

完整的端到端配置，包括 Cloudflare Access、MFA 首次注册、App Launcher 引导、
验证和故障排查，请参阅
[Cloudflare Tunnel 私有部署指南](docs/cloudflare-tunnel.md)。

使用 Cloudflare Tunnel 时，Ask Codex 仍可只监听回环地址，无需监听
`0.0.0.0`，也无需在路由器上开放端口：

```bash
# 请先将一个强随机值加载到 ASK_CODEX_TOKEN。
ASK_CODEX_HOST=127.0.0.1 \
ASK_CODEX_PORT=4173 \
ASK_CODEX_PUBLIC_ORIGIN=https://codex.example.com \
ASK_CODEX_TOKEN="$ASK_CODEX_TOKEN" \
npm start
```

`ASK_CODEX_PUBLIC_ORIGIN` 必须是一个完整的 `http://` 或 `https://` Origin，
不能包含路径、查询参数、片段或登录凭据。

将 Tunnel 指向这个本机服务：

```yaml
ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:4173
  - service: http_status:404
```

请保留请求原始的公网 `Host`。尤其不要把 Cloudflare Tunnel 的
`httpHostHeader` 配置成 `localhost` 或 `127.0.0.1`；Ask Codex 会根据
`ASK_CODEX_PUBLIC_ORIGIN` 同时校验 `Host` 和 `Origin`。请配置 Cloudflare
Access，仅允许你自己的身份访问该域名并强制 MFA，同时仍使用强随机
`ASK_CODEX_TOKEN` 作为独立的应用层门禁。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run lint
# 先在 4173 端口启动生产服务，再运行：
npm run check:visual
```

Codex 协议随已安装的 CLI 版本变化。升级 Codex 后，请运行上述检查，并对会话恢复、
命令审批和文件审批流程进行冒烟测试。

## 为什么不直接复用 `pi-web` 或 `codex-web`？

`pi-web` 直接嵌入 pi Agent SDK 及其会话模型，因此不能在不替换事件层和审批层的
情况下直接换成 Codex 后端。当前的 `0xcaff/codex-web` 会复用经过补丁修改的
Codex Desktop Electron 包和私有 IPC。Ask Codex 改为面向有文档的 app-server
接口，因此集成面更小，也不需要重新分发桌面应用。

底层会话、轮次、条目和审批协议请参阅官方
[Codex app-server 文档](https://developers.openai.com/codex/app-server/)。
