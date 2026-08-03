# 项目进度

**简体中文** | [English](progress.en.md)

最后审阅：2026-08-04

## 当前里程碑

线程工作目录的连续性和文件交接已经实现。新线程默认继承当前所选线程的精确 cwd，没有
选择时才使用 bootstrap 初始目录，并始终从 `workspace-write` 沙箱开始。已完成 Agent
消息明确链接的 cwd 内普通文件可以通过二次确认下载；浏览器只兑换短期一次性 capability，
不能提交宿主机路径，网关也不使用全局下载根列表。下一项近期工作尚未选定。

## 当前基线

当前实现包括：

- 用于列出、搜索、创建、恢复和刷新 Codex 原生线程的 React 桌面端与移动端布局，
  包括 44 像素高的对话标题栏，以及始终可编辑、回车换行并可通过按钮或 `Ctrl+Enter`
  发送的响应式多行输入框；macOS 同时支持 `Cmd+Enter`。未确认成功的发送会与发送期间
  继续输入的新草稿分开保留。新建线程在首轮期间会保留在侧边栏，直到 active 或
  archived 官方列表确认其元数据；并发列表刷新只采用最新结果，轮次完成后会主动补全
  名称、预览和时间，因此稀疏状态通知不会使条目消失或退化为 UUID。
- Active/Archived 双视图按精确 cwd 分组，并在每组中先显示置顶线程，再保持其他线程的
  原有顺序。统一线程动作菜单支持桌面端右键、移动端 550 毫秒长按和所有端的 `...`
  入口；重命名、置顶和取消置顶即使在线程有运行中轮次时也可使用。运行中线程仍不能
  归档或删除；其他空闲线程可归档，已归档线程可恢复，两类空闲线程均可在明确提示线程
  及其后代会话可能被永久移除后确认删除。来自其他客户端的名称、归档、恢复和删除通知
  会同步列表与当前选择；删除还会清理该线程在内存和 IndexedDB 中的浏览器本地图片预览。
- 第四个只读 Skills 标签按 cwd 展示 skill 名称、描述、`user`/`repo`/`system`/`admin`
  作用域和启用状态，并只用计数提示无法加载的条目。目录在首次打开标签时开始加载；手动
  刷新发送 `forceReload: true`，`skills/changed` 通知则使已经加载过的目录重新扫描。
  最多加载 16 个目录且当前 cwd 优先；已删除的历史目录会单独降级，不会遮蔽其他项目。
  请求与线程列表刷新分别采用 generation 保护，较旧响应不会覆盖较新的目录或线程状态。
- 第三个只读 Activity 标签将线程原生 runtime status、`activeFlags`、待处理请求以及有界的
  `turn/started`、`turn/completed` 和 `thread/status/changed` 事件合成为 Needs attention、
  Running now 和 Recent 三段目录。近期事件环只保存线程 ID、可选轮次 ID、活动种类、时间
  和可用时的轮次耗时，显示所需的名称与 cwd 来自只读线程列表；它不跨线程保留命令输出、
  MCP 参数或文件内容。显式 idle 快照会压过断线前遗留的瞬时运行事件。查看或刷新 Activity
  只读取线程列表，不会恢复、认领线程或改变审批路由，点击条目才执行正常的用户选择流程。
- 工具栏显示 Connecting、重试次数、Disconnected/Error、Connected · Syncing、Sync
  failed、Ready 或 Working，并允许立即重试。WebSocket 退避次数只在 Codex 真正 ready
  后清零；首次 ready 建立基线，Codex 子进程 Error 状态的重试使用有界 `model/list`
  只读探测触发网关重启，WebSocket 故障则重建浏览器连接。同一连接或新连接上的后续 ready
  会在重新启用
  发送前通过 `thread/read` 和
  `thread/turns/list` 对当前线程执行只读快照同步，并继续复用有界通知缓冲与两阶段协调器。
  同步失败会继续禁用发送并提供只读重试；断线会清理浏览器中的旧审批，网关仍会在重连后
  重新投递尚未解决的请求。恢复不会自动重放 `turn/start` 等未确认写操作；若断线打断了
  用户首次加载线程，则要求用户明确重试，也不会调用会改变 owner 的后台 `thread/resume`。
- 工具栏 Usage 对话框显示最多 32 个线程的内存 token 快照中的当前线程数据、最近上下文
  占用、账户累计和最近每日活动，以及单 bucket 或多 bucket 速率窗口、重置时间和安全的
  credit 摘要。账户读取并行调用 `account/usage/read` 与 `account/rateLimits/read`；滚动
  `account/rateLimits/updated` 按稀疏语义合并，读取期间抵达的更新不会被较旧响应覆盖，
  缺失或空账户元数据不会清除完整快照，滚动 bucket 也保持 32 条上限。已触及的速率或
  spend-control 上限会明确标出；API key 或 Bedrock 等不支持账户用量的登录会在面板内
  独立降级，不产生误导性 toast。
- 通过 `thread/turns/list` 增量加载近期轮次，支持自适应分页大小、可重试的更早页面和
  摘要降级。新线程由 app-server 选择默认历史契约，不再强制实验性的 `paginated`
  模式；已有分页线程仍可通过严格受限的 `thread/items/list` 按升序逐页恢复，默认或
  `legacy` 线程保留单轮完整详情重试。
- 流式显示消息、推理、计划、命令输出、文件变更、MCP 调用、网页搜索、轮次 diff，
  并为未知条目提供降级渲染；连续且有内容的历史推理在原位置合并并可展开，进行中轮次底部
  则保留固定的推理状态槽，活动推理显示动画，无活动推理时显示灰态，从而避免推理生命周期
  反复改变信息流高度。当前轮次的结构化计划会同时在输入区上方显示为普通布局的紧凑摘要，
  可展开查看有界滚动的完整步骤；轮次结束后摘要消失，历史计划仍留在原轮次中。
  轮次 diff 明确呈现为位于轮次末尾的整轮变更汇总；其后的轮次 footer 会显示
  app-server 原生的开始时间与总耗时，缺失字段则静默省略。流和消息大小均有明确边界。
  完成或重同步返回的非完整轮次快照不会清空已经流式物化的内容，只有明确的 `full` 快照
  可以替换条目。
- 可复用的语法高亮代码块、复制和换行控件、结构化统一/并排 diff、安全的原始 diff
  降级，以及有界的两级工具折叠区；连续且已正式支持的机器活动组成零间距、仅由单条横线
  分隔的活动栈，包括命令、文件变更、MCP 调用、搜索、动态工具、subagent/collab，以及
  图片查看和生成，同时突出显示助手消息。
- 已完成 Agent 消息中的显式绝对本地 CommonMark 链接可显示为带二次确认、处理中、失败和
  下载已启动状态的控件；没有有效 capability 的绝对本地链接降级为 inert 文本，外部
  网页链接保持原行为。网关只根据 app-server 权威 `thread.cwd` 和完成态证据签发短期、
  一次性 opaque ID，不接受浏览器路径、cwd、thread ID、请求体或查询参数，也不使用
  `ASK_CODEX_DOWNLOAD_ROOTS`。消费时以固定的 canonical 根目录 fd 解析目标，并复核根
  `dev`/`ino`、目标 `realpath`、已打开文件 fd、普通文件类型、25 MiB 大小、2 个并发下载
  和 2 分钟活动传输时限。
- 在浏览器中处理命令和文件变更审批，以及结构化的 `request_user_input` 请求。捕获到
  的命令审批理由会在当前浏览器会话中继续绑定到对应的确切命令条目。
- 新线程的工作目录和沙箱设置、空闲线程的显式沙箱覆盖、输入框旁的下一轮模型与推理
  控件，以及中断活跃轮次。有当前选择时，新线程 cwd 依次取精确匹配的当前线程、Active
  或 Archived 摘要；没有选择时取 bootstrap 默认 cwd。新线程沙箱始终重置为
  `workspace-write`。初始模型和推理强度取自经过严格过滤的 Codex 有效配置；备选项来自
  `model/list`。已有线程的 cwd 只读，常规恢复不再重新发送扁平化的沙箱状态。
- Express/WebSocket 网关：通过 JSONL stdio 启动 `codex app-server`，根据显式 RPC
  allowlist 重建参数，并将 app-server 请求路由到所属浏览器。`thread/name/set`、
  `thread/metadata/update` 和 `skills/list` 只接受逐字段重建的有界参数；Skills 响应
  只向浏览器投影名称、描述、扁平化的 `interface.shortDescription`、作用域、启用状态和
  每个 cwd 的错误计数，不转发 skill 路径、依赖、其余 interface 元数据或具体错误文本；
  来自上游 app-server 的顶层 Skills RPC 错误也使用固定消息脱敏。账户用量和限额读取只
  接受空参数并向上游发送无参数请求；结果最多投影 366 个每日 bucket 和 32 个限额 bucket，
  丢弃账户身份、reset-credit 细节和未知字段。`account/rateLimits/updated` 通知使用同样的
  逐字段稀疏投影，三类账户读取错误均使用固定消息脱敏。
- 输入框支持选择、粘贴、预览、删除和单独发送 PNG、JPEG、WebP 图片，并只在模型明确
  声明图片输入能力时开放入口。图片二进制通过复用现有 HTTP 令牌与 Origin/Host 策略的
  临时附件端点上传，一次性 ID 在网关内重建为官方 `localImage` 路径；数量、字节、并发、
  存储和生命周期均有边界。成功发送的图片会在 IndexedDB 中保存有界的浏览器本地预览，
  同一浏览器配置文件通过同一 Origin 可在页面或线程重载以及浏览器重启后恢复可点开的
  缩略图。本地副本默认 TTL 为 30 天，最多 8 张、共 40 MiB；清除站点数据、浏览器回收
  存储，或换用其他设备、浏览器、配置文件或 Origin 后，历史图片回退为安全占位符。
- 有界的浏览器、网关和 app-server 消息；线性 JSONL 累积；背压驱逐；审批重路由；
  以及超大通知无法转发时基于快照的恢复。
- 强制执行 `on-request` 用户审批、不支持的权限失败时关闭、默认只绑定回环地址、
  token 和 Origin 检查、连接与请求限制，以及对精确受信任公共 Origin 的支持。
- 中英文 Cloudflare Tunnel 部署指南，用于仅绑定回环地址的 Cloudflare Access，
  并保留独立的 Ask Codex token 关卡。
- 确定性的桌面端和移动端生产环境视觉夹具，不会创建真实 Codex 轮次。

本文档描述 `main` 上当前已验证的交接基线。另一台设备拉取最新 `origin/main` 后，即可
在不依赖之前聊天记录的情况下按“后续步骤”继续；只有“验证”中明确列出的检查才视为已经
执行。

## 已知缺口

- 默认或现有 `legacy` 线程没有官方迁移方式，也不支持 `thread/items/list`；如果它的单轮
  完整载荷仍超过网关上限，就只能保留摘要。分页线程中的单个条目若自身超过 1 MiB，
  同样无法通过缩小页面恢复。
- 上次在 Codex CLI 0.145.0 上验证时，分页线程不支持 fork、rollback 和 detached
  review。Ask Codex 当前没有公开这些操作，但其他客户端操作同一原生线程时仍受此限制。
- 已加载的历史页面会一直挂载。内容较重但已折叠的区域采用惰性处理，Markdown/diff
  工作量也有边界，但在手动展开大量历史时，尚未使用视口虚拟化或整体 DOM 预算。
- 上次在 Codex CLI 0.145.0 上验证时，已完成的 `commandExecution` 历史不包含审批
  理由。Ask Codex 可以保留当前浏览器会话期间捕获的理由，并在会话内重新同步时保留
  它们，但页面刷新后或换到另一台设备时，无法从原生线程历史重建这些理由。
- Activity 的近期事件环只存在于当前页面内，并不是持久审计日志。实时状态范围限于当前
  Ask Codex app-server 进程能够列出或广播的线程；其他 CLI/IDE 进程不会共享逐项实时流。
  `account/usage/read` 和账户速率限制也可能因认证方式或服务端支持情况不可用，并且这些
  数据不是 API 账单或精确美元成本。线程 fork 仍未开放。
- 图片附件会在轮次完成后删除。Codex 的正常后续上下文不受影响，但其他原生客户端无法
  再使用已删除的 `localImage.path` 编辑历史并重新附加原图片；持久附件所有权和回收
  尚未设计。浏览器本地预览不是跨设备附件存储，只在同一浏览器配置文件和 Origin 中
  可用，并可能因 30 天 TTL、8 张/40 MiB 上限、站点数据清理或浏览器回收而变成占位符。
  通用文件和音频输入也未开放。
- 文件下载不会列目录、接受浏览器指定路径、预览任意格式，或导出没有出现在合格完成态
  Agent 消息中的文件。capability 只存在于当前服务进程且短期一次有效；服务重启、过期或
  首次消费后，需要重新读取合格历史才能获得新 capability。
- 轮次 steering、跨设备持久消息队列、固定宿主机操作和嵌入式 PTY 尚未实现。

## 后续步骤

本轮近期里程碑已经完成；下一项尚未选定。候选项保留在 [`ideas.md`](ideas.md) 中，
出现在该文档中并不代表交付承诺。

## 风险与注意事项

- 已安装的 Codex CLI 定义持续演进的协议。协议工作必须比较生成的 bindings，并同时
  更新规范化逻辑和测试。
- `paginated` 历史仍是实验性持久化契约。除非 app-server 提供明确的能力声明并完成真实
  首轮验证，否则不要为新线程强制启用；升级 CLI 时仍须重新核对条目分页以及 fork、
  rollback 和 detached review 的支持情况。
- 富文本渲染必须把所有智能体、命令、diff 和 ANSI 内容视为不可信文本，并限制内存
  和 DOM 增长。
- 文件下载范围必须继续只由 app-server 权威 `thread.cwd` 和已完成 Agent 消息中的显式
  绝对链接共同派生；浏览器不得选择路径。签发时固定 canonical 根身份，消费时通过根目录
  fd、目标 `realpath` 和文件 fd 复核 containment，并保留一次性、TTL、大小、并发及集合
  上限。`thread.cwd` 为 `/` 时范围很宽，因此 `ASK_CODEX_TOKEN` 必须按宿主机账户密码保护。
- 现代审批理由必须继续以线程、轮次和条目 ID 为键；只有旧版 call ID 能唯一标识一个
  命令时才附加它。
- 网关必须继续把 `config/read` 结果投影为仅包含模型和推理强度；绝不能转发完整的
  Codex 配置。
- 图片二进制必须继续留在 WebSocket JSON 之外；浏览器不得提供宿主机路径，临时附件
  的格式校验、配额、一次性消费和清理兜底也不能被绕过。
- IndexedDB 预览只能保存恢复所需的 thread/turn 组合键、Blob、媒体类型、大小、顺序和
  生命周期元数据，不能保存 token、宿主机路径、原始文件名或一次性附件 ID；本地存储
  失败不得影响已接受的轮次。
- Skills 和未来的宿主机工具不得绕过网关 allowlist；Skills 目录必须继续剥离 skill
  路径、依赖、`interface.shortDescription` 之外的 interface 元数据和错误文本，不能
  引入路径或命令透传。
- 自动恢复和只读视图不得声称拥有线程，也不得把审批请求从启动或恢复该线程的浏览器
  重定向出去。普通重连和 Codex 重启只能自动重试有界只读请求，不得重放未确认写操作。
- 账户用量与限额方法必须继续使用空参数重建、结果和通知逐字段投影、有界集合及固定上游
  错误消息；滚动限额通知是稀疏更新，不能用缺失或空字段清除最近的完整快照。
- 浏览器终端会绕过 Codex 审批，因此需要独立的威胁模型、隔离边界和显式启用机制。

## 验证

本轮已于 2026-08-04 使用 Node.js `v24.18.0`、npm `12.0.2` 和 Codex CLI
`0.146.0` 完成验证：

- 从已安装 CLI 生成当前 experimental TypeScript bindings，并核对
  `Thread.cwd`、`ThreadStartedNotification`、`ItemCompletedNotification`、
  `TurnCompletedNotification`、轮次状态以及 `thread/items/list` 的相关结构；没有创建真实轮次。
- `npm run typecheck`、`npm run lint` 和 `npm run build` 通过。
- `NODE_ENV=test npm test` 通过：34 个测试文件、484 项测试；服务端测试在允许绑定回环
  套接字的环境中运行。
- `CHROME_BIN=/usr/bin/chromium ASK_CODEX_VISUAL_URL=http://127.0.0.1:4174
  ASK_CODEX_VISUAL_OUTPUT=/tmp/ask-codex-file-download-visual-final-3 npm run check:visual`
  针对当前生产构建通过。桌面端和 390x844 移动端夹具确认下载二次确认的宽度稳定、控件
  contained、焦点、建议文件名和下载已启动状态，并继续覆盖项目导航、Activity、Skills、Usage、
  富内容、推理状态槽、图片和输入区；未发现水平溢出、裁切、内容重叠、console error 或
  page error。所有 RPC 和下载均由确定性浏览器夹具拦截，没有创建真实 Codex 轮次。
