# 项目进度

**简体中文** | [English](progress.en.md)

最后审阅：2026-08-09

## 当前里程碑

P2 跨设备持久消息队列已完成：一个设备可把已有线程的纯文本保存到网关 outbox，另一台已认证
设备只在用户显式操作后发送或取消。队列以 revision 阻止同网关并发双发，发送前核对线程状态
与最后轮次，未知 `turn/start` 结果进入不可重放的 `indeterminate`；不使用实验性 Codex API。
同时修复了 Working -> Retry -> Sync 窗口中旧重同步快照可能吞掉较新 Plan 通知的竞态，以
网关单调 revision 裁决覆盖关系。此前完成的多类型文件输入、受限原生 fork、文本 steering、
长历史整体 DOM 预算、cwd 连续性、Agent 输出文件交接和网关安全硬化继续保持。下一候选是
P3 持久 Activity 审计，尚未开始。一次性免审批提示模式按 turn 工作：每轮默认手动，已有
空闲线程或完成配置的新线程草稿可显式让下一次直接轮次使用 `never`，结束或启动失败后恢复
手动；线程创建、队列、steering 和实验性设置 API 均不参与，沙箱不变。

## 当前基线

当前实现包括：

- 输入区提供一次性免审批提示开关，只在当前选中的已有空闲线程，或新线程草稿完成配置后可
  修改。每个 turn 默认手动；显式开启后，下一次直接 `turn/start` 使用
  `approvalPolicy: "never"`，Working 时保持显示但禁用，轮次结束、取消、失败或启动结果无效
  时关闭，下一轮必须重新开启。新线程的 `thread/start`、恢复、队列消费和 steering 继续固定
  手动审批；只有创建成功后独立发起的首个 `turn/start` 可使用草稿上的当次选择。网关始终
  注入用户 reviewer，且 `never` 不放宽当前 sandbox。
- 用于列出、搜索、创建、恢复和刷新 Codex 原生线程的 React 桌面端与移动端布局，
  包括 44 像素高的对话标题栏，以及始终可编辑、回车换行并可通过按钮或 `Ctrl+Enter`
  发送的响应式多行输入框；macOS 同时支持 `Cmd+Enter`。轮次运行时，同一输入框可向提交时
  捕获的活跃轮次发送纯文本 steering；附件草稿保持不变，但附件、模型和 effort 控件继续
  禁用。未确认成功的普通发送或 steering 会与发送期间继续输入的新草稿分开保留；原轮次
  不再活跃后，失败的 steering 仍保留但不能被错误重试为新轮次。新建线程在首轮期间会
  保留在侧边栏，直到 active 或
  archived 官方列表确认其元数据；并发列表刷新只采用最新结果，轮次完成后会主动补全
  名称、预览和时间，因此稀疏状态通知不会使条目消失或退化为 UUID。
- Active/Archived 双视图按精确 cwd 分组，并在每组中先显示置顶线程，再保持其他线程的
  原有顺序。统一线程动作菜单支持桌面端右键、移动端 550 毫秒长按和所有端的 `...`
  入口；重命名、置顶和取消置顶即使在线程有运行中轮次时也可使用。空闲的 Active 或
  Archived 线程可以 fork；成功后通常选择新线程，若用户在请求期间已经切换则只更新列表。
  运行中线程仍不能 fork、归档或删除；其他空闲线程可归档，已归档线程可恢复，两类空闲线程均可在明确提示线程
  及其后代会话可能被永久移除后确认删除。来自其他客户端的名称、归档、恢复和删除通知
  会同步列表与当前选择；删除还会清理该线程在内存和 IndexedDB 中的浏览器本地图片和文件副本。
- 输入框可把当前已有线程的非空纯文本加入服务端持久 outbox，队列面板默认收起、按线程显示，
  并在其他已认证浏览器发生变化时重新读取。只有完成只读同步且线程空闲的浏览器显式点击后
  才发送；
  队列不会在启动、重连、Codex ready、定时器或活跃轮次中后台消费，也不转换为 steering。
  发送前稳定读取线程状态与最后轮次；上下文变化、忙碌、不可用或已知拒绝进入二次确认，
  可能已经执行但未取得有效结果的写入进入不可重放的 `indeterminate`。网关以原子 JSON 文件
  持久化有界状态，保留 `externalSandbox` 和人工审批，并把成功发送的浏览器设为审批 owner。
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
  `legacy` 线程保留单轮完整详情重试。已加载历史通常只挂载最新 24 个轮次，Earlier/Newer
  每次移动 12 个轮次；活跃轮次固定占用其中一个名额。前插历史、新轮次追加、离底浏览和
  切换线程分别保持可预期的窗口与滚动位置。`thread/fork` 固定排除初始响应中的完整历史，
  新线程同样走该分页路径，因此默认和 `paginated` 来源不会因长历史扩大 fork 响应。
- 流式显示消息、推理、计划、命令输出、文件变更、MCP 调用、网页搜索、轮次 diff，
  并为未知条目提供降级渲染；连续且有内容的历史推理在原位置合并并可展开，进行中轮次底部
  则保留固定的推理状态槽，活动推理显示动画，无活动推理时显示灰态，从而避免推理生命周期
  反复改变信息流高度。当前轮次的结构化计划会同时在输入区上方显示为普通布局的紧凑摘要，
  可展开查看有界滚动的完整步骤；轮次结束后摘要消失，历史计划仍留在原轮次中。若最后一次
  Plan 快照仍含进行中或待处理步骤，历史视图会把它标记为“轮次结束时的最后状态”并停止动画，
  不会伪造完成状态。
  实时 Plan 与恢复快照使用同一份严格有界投影；网关按线程与轮次缓存最新完整通知，并将其
  附加到只读轮次响应和生命周期通知。Plan 对象、明确不可恢复的 `null` 和缓存未知的缺失字段
  分别覆盖、清除或保留浏览器状态。网关为实时 Plan 与缓存快照附加同进程单调 revision；
  重同步只丢弃 revision 已被快照覆盖的缓冲通知，较新的通知继续按到达顺序应用。成功 fork
  会把当前进程内来源线程的有界 Plan 记录复制到新线程 ID，保留可恢复与明确不可恢复状态；
  它仍不把缓存升级为跨进程事实来源。轮次 diff 明确呈现为位于轮次末尾的整轮变更汇总；
  其后的轮次 footer 会显示
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
- 在浏览器中处理命令和文件变更审批，以及结构化的 `request_user_input` 请求。审批按钮和
  网关响应都收窄到协议允许且 app-server 在 `availableDecisions` 中实际提供的字符串决策；
  畸形、未知或只有客户端不支持的结构化决策会失败关闭。捕获到的命令审批理由会在当前
  浏览器会话中继续绑定到对应的确切命令条目。
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
- `thread/fork` 只接受来源线程 ID，网关固定 `on-request`、用户 reviewer 和
  `excludeTurns: true`，拒绝 rollout path、cwd、模型、权限、instructions、截断点和未知字段。
  响应必须证明新 ID、来源关系、绝对 cwd、历史模式、sandbox 与审批设置一致；浏览器看不到
  rollout path、instruction sources、runtime workspace roots 或未知结果字段。成功只认领
  新线程而不改变来源 owner，失败、断线、畸形结果和 ID 冲突均不认领，也不会自动重放。
- WebSocket 升级只接受原始 request-target 精确等于 `/ws`，在认证前拒绝 query、fragment、
  归一化路径和 authority/absolute-form 混入。普通 `thread/resume` 不发送 sandbox 覆盖，
  因而保留 `externalSandbox`；显式覆盖先用固定参数探测权威 sandbox，并对不可信响应或并发
  settings 通知失败关闭。同线程的 resume、turn start 和 text steering 串行，未知结果会
  取消已排队后继；thread owner 只在上游返回结构有效的成功结果时同步提交。Steering 响应还
  必须返回与已清洗 `expectedTurnId` 相同的 `turnId`；失败、断线或畸形结果不会抢占旧 owner。
- 输入框的 `+` 菜单支持选择图片或普通文件；剪贴板将 PNG、JPEG、WebP 归入图片预览，
  其余文件归入带名称和大小的文件卡片。图片入口只在模型明确声明图片输入能力时开放，普通
  文件不依赖该声明；两类附件合计每轮最多 4 个、每个最多 10 MiB。二进制通过复用现有 HTTP
  token 与 Origin/Host 策略的临时端点上传；图片 ID 在网关内重建为官方 `localImage`，文件
  ID 则物化为不含路径的历史 marker 和网关控制的 application `additionalContext`。浏览器
  不能提交路径、cwd 或 `additionalContext`，数量、字节、并发、存储和租约生命周期均有边界。
  成功发送的图片预览和普通文件下载副本分别有界保存在同源 IndexedDB；默认 TTL 均为 30 天，
  各自最多 8 个、共 40 MiB。文件历史元数据必须与本地 Blob 完全匹配才允许下载；清除站点
  数据、浏览器回收存储，或换用其他设备、浏览器、配置文件或 Origin 后均回退为安全占位符。
- 有界的浏览器、网关和 app-server 消息；线性 JSONL 累积；背压驱逐；审批重路由；
  以及超大通知无法转发时基于快照的恢复。
- 线程创建、恢复、队列和每个普通直接轮次默认强制 `on-request` 用户审批；只有已有空闲线程，
  或已配置新线程草稿上用户显式选择的下一次直接轮次可使用 `never`。新线程创建本身仍固定
  `on-request`。同时保留不支持权限失败时关闭、默认只绑定
  回环地址、token 和 Origin 检查、连接与请求限制，以及对精确受信任公共 Origin 的支持。
- 中英文 Cloudflare Tunnel 部署指南，用于仅绑定回环地址的 Cloudflare Access，
  并保留独立的 Ask Codex token 关卡。
- 确定性的桌面端和移动端生产环境视觉夹具，不会创建真实 Codex 轮次。

本文档描述其所在提交已验证的交接基线。源码和项目文档仍通过 Git 在设备间同步；另一台设备
取得包含本文件的提交后即可继续。只有“验证”中明确列出的检查才视为已经执行。

## 未完成事项与边界

原有九条缺口不再作为同等优先级的平铺清单。P1 的 steering、整体 DOM 预算，以及 P2 fork、
多类型文件输入和跨设备持久消息队列已完成；其余内容按可实施性规整如下。优先级表示当前建议
顺序，不是交付承诺。

### 候选实施项目

- **P3，单独实施**：持久 Activity 审计。它需要单独定义数据敏感度、保留期和事实来源，
  不能直接复用结构化 Plan 的有界恢复缓存。
- **P3，独立安全项目**：固定宿主机操作只能暴露服务端配置的操作 ID。嵌入式 PTY 不与其
  捆绑，当前不排期；若以后实施，必须另建隔离边界和威胁模型。

### 上游或协议限制

- 默认和现有 `legacy` 线程没有官方迁移方式，也不支持 `thread/items/list`；单轮完整载荷
  超过网关上限时只能保留摘要。分页线程的单个条目若自身超过 1 MiB，也无法靠缩小页面恢复。
- 上次在 Codex CLI 0.145.0 上验证时，分页线程不支持 rollback 和 detached review。
  这些原生历史操作必须在每次相关 CLI 升级后重新核对，客户端不能自行补出等价能力。
- 已完成的 `commandExecution` 原生历史不包含审批理由。当前浏览器会话可以保留已捕获理由，
  但页面刷新或换设备后无法从线程历史重建。
- 其他 CLI/IDE app-server 进程不共享逐项实时 Activity 流；账户用量和限额也可能因认证方式
  或服务端支持而不可用，并且不是 API 账单或精确美元成本。
- 官方 Turn 和读取响应不含结构化 Plan。网关重启、缓存逐出或通知抵达网关前丢失后，
  当前协议不能从原生历史重建 Plan。

### 已接受边界

- 按 ADR 0013，文件下载刻意不列目录、不接受浏览器路径，也不导出未出现在合格完成态
  Agent 消息中的文件；capability 保持短期、一次性且只存在于当前服务进程。这是安全范围，
  不是待补功能。
- 按 ADR 0017，图片和普通文件的服务端副本在轮次完成后删除；IndexedDB 预览或下载副本只服务
  同一浏览器配置文件和 Origin，并分别受 30 天、8 个/40 MiB 等上限约束。缺少同源本地副本时
  历史只显示安全占位，不把本地副本描述为跨设备存储或可由 Codex 重新读取的持久附件。
- 按 ADR 0014，结构化 Plan 恢复刻意使用进程内有界缓存，而不是新的持久会话数据库；它覆盖
  普通断线和 Codex 子进程重启，但不承诺跨网关进程或跨设备重建。这是已接受取舍，不是普通欠账。
- 按 ADR 0018，跨设备队列只持久化纯文本并由已同步浏览器显式消费。它不自动执行、不重放
  未知结果、不支持附件，也不是两个网关或两台宿主机之间的共享数据库。
- 浏览器不得提交任意命令或获得隐式 shell。固定操作和 PTY 即使未来实现，也必须保持与
  Codex 审批分离的明确授权和隔离边界。

## 后续步骤

本轮 P2 跨设备持久消息队列和 Plan 重同步竞态修复已经完成。下一候选是 P3 持久 Activity
审计：先定义敏感数据范围、事实来源、保留期与查询边界，再决定存储；尚未进入实现。其他候选
保留在 [`ideas.md`](ideas.md) 中，出现在任一文档中都不代表交付承诺。

## 风险与注意事项

- 已安装的 Codex CLI 定义持续演进的协议。协议工作必须比较生成的 bindings，并同时
  更新规范化逻辑和测试。
- `paginated` 历史仍是实验性持久化契约。除非 app-server 提供明确的能力声明并完成真实
  首轮验证，否则不要为新线程强制启用；升级 CLI 时仍须重新核对条目分页及相关原生历史
  操作的支持情况。
- `thread/fork` 必须继续只接受来源线程 ID，并固定排除完整历史与权限覆盖；其无幂等键，
  断线或超时后的未知结果不得自动重放。CLI 升级时应重新核对参数、来源关系、返回历史模式
  和 `thread/turns/list` 兼容性，但不能用一次真实 fork 探测来替代能力声明。
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
- 附件二进制必须继续留在 WebSocket JSON 之外；浏览器不得提供宿主机路径或
  `additionalContext`，临时附件的格式或元数据校验、配额、一次性消费和清理兜底也不能被绕过。
- IndexedDB 本地副本只能保存恢复所需的 thread/turn 组合键、Blob、媒体类型、大小、顺序和
  生命周期元数据；普通文件可以保存显示与下载所需的原始文件名，图片仍不保存原始文件名。
  两者都不能保存 token、宿主机路径或一次性附件 ID，本地存储失败不得影响已接受的轮次。
- Skills 和未来的宿主机工具不得绕过网关 allowlist；Skills 目录必须继续剥离 skill
  路径、依赖、`interface.shortDescription` 之外的 interface 元数据和错误文本，不能
  引入路径或命令透传。
- 自动恢复和只读视图不得声称拥有线程，也不得把审批请求从启动或恢复该线程的浏览器
  重定向出去。普通重连和 Codex 重启只能自动重试有界只读请求，不得重放未确认写操作。
- 一次性 `never` 只能影响用户显式发起的下一次直接轮次；新线程草稿获得真实 ID 时只允许把
  选择转移给同一次提交的首轮。UI 不得持久化或跨其他线程携带开关，后续 Ask Codex 写入必须
  显式恢复 `on-request`。由于上游设置可能在这次写入前保持粘性，
  同一窗口内其他 Codex 客户端的审批行为不由本 UI 保证，也不得通过自动 `thread/resume`
  改变 owner 来消除该窗口。
- `turn/steer` 必须继续绑定提交时捕获的 `expectedTurnId`，只允许文本并逐字段重建输入；
  响应 `turnId` 不匹配时失败关闭。断线恢复不得自动重放 steering，失败重试也不得退化为
  `turn/start`。
- `turn/plan/updated` 是完整快照，必须继续以 JSONL/WebSocket 到达顺序为权威，并让实时通知
  与缓存恢复使用同一份逐字段投影和资源上限。重同步只能用同网关单调 revision 证明通知已被
  快照覆盖；缺失 revision 时必须保守重放。`emittedAtMs` 与 `gatewayReceivedAtMs` 只能用于
  诊断，不能用于重排 Plan 状态。
- 持久消息队列必须继续显式消费、按 item revision 并发控制，并在写结果未知时保持
  `indeterminate`。不得因重连、启动或 Codex ready 自动发送，也不得把 `clientUserMessageId`
  字段存在本身当作已证明的幂等保证。队列文件含用户明文，必须保持单进程、权限和容量边界。
- sandbox probe 与实际 override 是两个独立的 app-server RPC；当前协议没有 CAS 或 revision
  条件写接口，其他 Codex 进程仍可能在两次调用之间改变 sandbox。网关会串行本进程请求、
  监测 probe 期间的 settings 通知并复核最终响应，以缩小窗口并对不一致失败关闭，但不能
  提供跨进程原子保证。
- 账户用量与限额方法必须继续使用空参数重建、结果和通知逐字段投影、有界集合及固定上游
  错误消息；滚动限额通知是稀疏更新，不能用缺失或空字段清除最近的完整快照。
- 浏览器终端会绕过 Codex 审批，因此需要独立的威胁模型、隔离边界和显式启用机制。

## 验证

当前工作树已于 2026-08-09 使用 Node.js `v24.18.0`、npm `12.0.2` 和 Codex CLI
`0.147.0` 完成验证：

- 2026-08-07 已从同版本 CLI 分别生成 stable 和 experimental TypeScript bindings，并核对
  `ThreadResumeResponse.sandbox`、`ThreadSettingsUpdatedNotification.threadSettings.sandboxPolicy`、
  `CommandExecutionApprovalDecision`、`ReviewDecision`、`TurnStartResponse`、
  `TurnSteerParams`、`TurnSteerResponse`、完整快照形式的 `TurnPlanUpdatedNotification`、
  `ThreadForkParams`、`ThreadForkResponse`、`Thread.historyMode`、不含 Plan 的官方 Turn
  读取结构，以及通知 envelope 的 `emittedAtMs`。本轮另核对 stable
  `TurnStartParams.approvalPolicy` 的 `on-request | never` 联合类型；队列还核对了
  `TurnStartParams.clientUserMessageId` 与 `thread/inject_items`，确认 schema 没有给出足以授权
  未知写重放的幂等作用域、持久期和冲突语义，因此实现未提交前者，也未调用后者。普通文件
  输入此前还完成了真实协议验证：
  `mention` 不适合普通本地文件，而由网关构造的 application `additionalContext` 可让 Codex
  准确读取受控临时路径；没有仅为自动化检查创建真实轮次或持久测试 fork。
- `npm run typecheck`、`npm run lint`、`npm run build` 和 `git diff --check` 通过。
- `NODE_ENV=test npm test` 通过：41 个测试文件、683 项测试；服务端测试在允许绑定回环套接字
  的环境中运行。队列覆盖原子持久化、损坏和配额失败关闭、重启恢复、跨客户端 revision、
  忙线程、上下文变化、未知发送结果、审批 owner 以及浏览器状态；Plan 覆盖同步竞态的 revision
  比较、缺失 revision 的保守重放，以及终态 turn 遗留 `in_progress` 快照时停止动画。审批覆盖
  已有线程和新线程首轮的单次 `never`、后续显式恢复 `on-request`，以及创建/启动失败后恢复手动。
- `CHROME_BIN=/usr/bin/chromium ASK_CODEX_VISUAL_URL=http://127.0.0.1:4444
  ASK_CODEX_VISUAL_OUTPUT=/tmp/ask-codex-turn-defaults-visual-final2 node scripts/visual-check.mjs`
  针对当前生产构建通过。桌面端和 390x844 移动端夹具覆盖审批、项目导航、Activity、Skills、
  Usage、Agent 输出下载、富内容、推理状态槽、图片、Plan、运行中 steering 输入区，以及新的
  跨设备队列、一次性审批开关、附件 `+` 菜单和普通文件历史卡片；验证了 Queue 默认收起、
  终态 Plan 停止旋转，以及已有线程和已配置新草稿都可逐轮开启并在切换后清除选择。队列展开
  和折叠时按钮、状态文字与输入框均保持可用，同源 Blob 缺失时的不可下载状态也保持完整。
  未发现水平溢出、裁切、内容重叠、
  console error 或 page error。所有 RPC、上传和下载均由确定性浏览器夹具拦截；线程动作菜单
  在两种视口均包含且容纳 Fork，没有创建真实 Codex 轮次或 fork。
- 对 4444 常驻实例发送了必定在网关失败的无效 `approvalPolicy` 能力探针，运行态返回了预期的
  `on-request | never` 校验结果，证明现有进程已加载相关 RPC 白名单；探针未转发到 app-server，
  也未创建真实轮次，因此本次首轮 UI 扩展不需要中断当前会话重启网关。
- 对 14 个本轮相关中英文文档执行了本地 Markdown 链接检查，全部目标均存在。
