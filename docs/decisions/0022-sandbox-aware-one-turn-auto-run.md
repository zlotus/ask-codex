# ADR 0022：以沙箱感知自动运行取代免审批提示模式

- 状态：已接受
- 决策日期：2026-08-09
- 取代：[ADR 0020](0020-one-turn-prompt-free-approval.md)、[ADR 0021](0021-first-turn-one-shot-prompt-free-approval.md)
- 修订：[ADR 0002](0002-security-gateway-and-manual-approval.zh-CN.md)

## 背景

ADR 0020 和 ADR 0021 使用 `approvalPolicy: "never"` 实现逐 turn 的免审批提示。
这个策略不会扩大 sandbox，但也不会产生可交给用户处理的越界审批请求；工作区外写入、受限
网络访问等需要越过 sandbox 的操作只能直接失败。产品需要的自动化边界并不是“关闭所有提示”，
而是让当前 sandbox 已允许的操作自动执行，同时仍由用户审批越界请求。

Codex CLI 0.147.0 通过不带 `--experimental` 的
`codex app-server generate-ts` 生成的稳定 `AskForApproval` 包含 `untrusted` 和
`on-request`。[OpenAI 官方沙箱与审批组合](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations)
说明：`untrusted` 只自动运行已知安全操作，并在执行不可信命令前请求审批；`on-request`
可自动执行当前 sandbox 内允许的操作，但在工作区外写入、受限网络访问等越界场景仍请求
审批。这两种策略都可继续把 reviewer 固定为用户。

## 决策

- 新线程创建、线程恢复、原生 fork 和跨设备队列消费继续固定
  `approvalPolicy: "on-request"` 与 `approvalsReviewer: "user"`。Steering 不携带审批策略。
- 每个普通直接 `turn/start` 显式使用 `approvalPolicy: "untrusted"`。浏览器省略该字段时，
  网关也按 `untrusted` 重建，使严格模式成为失败关闭的默认值。
- 当前已有线程空闲，或新线程草稿已完成 cwd 与 sandbox 配置时，用户可为下一次直接 turn
  显式开启一次性自动运行。该 turn 使用 `approvalPolicy: "on-request"`，并继续由网关注入
  `approvalsReviewer: "user"`。sandbox 内已允许的操作自动执行；sandbox 升级、工作区外写入
  和受限网络访问等请求仍必须显示给用户审批。
- 网关对直接 `turn/start` 只接受 `untrusted` 或 `on-request`。浏览器提交 `never`、结构化
  `granular`、reviewer 或任何未知审批值时必须拒绝，不能把成熟 schema 中存在但未纳入产品
  安全模型的能力顺带开放。
- 一次性选择只存在于当前页面内存中，不持久化或跨线程、页面、设备传递。Working 和发送期间
  禁止切换；轮次完成、取消、失败、启动结果无效，或线程创建/轮次启动失败后恢复关闭。
  队列和 steering 不读取或消费该选择。
- 不使用实验性的 `thread/settings/update`、app-server WebSocket 传输或其他实验性 API。
  不支持的细粒度 `request_permissions` 和 MCP elicitation 继续失败关闭。
- Ask Codex 不在轮次结束后自动调用写 RPC 重置上游设置。下一次普通直接 turn 显式携带
  `untrusted`；创建、恢复、fork 和队列则继续显式携带各自固定的 `on-request`。

## 理由

把“非关键操作”定义为当前 sandbox 已允许的操作，可以复用 Codex 的成熟执行边界，而不让
浏览器或网关根据命令文本、工具名称、路径或模型理由自行推断风险。`untrusted` 与
`on-request` 形成有意义的两档稳定策略：前者提供更严格的逐命令审查，后者减少 sandbox 内
常规工作的中断，同时保留所有越界人工审批。

## 影响

- 一次性自动 turn 不再因需要 sandbox 升级而直接失败；标准命令和文件变更审批仍沿现有 owner
  路由显示在浏览器中。
- 默认直接 turn 可能比原先的 `on-request` 产生更多不可信命令审批，这是严格默认值的预期结果。
- 已认证但被攻陷的浏览器最多可为直接 turn 选择 `on-request`，不能再关闭审批提示。网关仍不
  把浏览器选择当作沙箱权限授予。
- 一个自动 turn 结束后，到 Ask Codex 下一次显式写入前，上游线程设置可能仍是 `on-request`。
  其他 Codex 客户端在该窗口中的行为不由本 UI 保证，但 sandbox 越界审批不会像 `never` 那样
  被关闭。
- UI 必须把该开关描述为“沙箱内自动运行”，不能继续称为“免审批”或暗示越界请求会自动批准。

## 考虑过的替代方案

- 继续使用 `never` 并由网关补回审批：拒绝，因为 `never` 下 app-server 不会发出可供网关接管
  的审批请求。
- 所有直接 turn 始终使用 `on-request` 并移除开关：可行但未采用，因为它会失去用户已接受的
  逐 turn 严格/自动选择。
- 按工具类别或命令文本在网关自动批准：拒绝，因为这些信号不能可靠表达路径、环境和实际影响。
- 使用稳定 `granular`：未采用，因为关闭类别代表自动拒绝而不是自动批准，不能实现目标语义。
- 使用 `approvalsReviewer: "auto_review"`：未采用，因为它会替换 sandbox 越界请求的人工
  reviewer，不符合越界仍由用户审批的要求。
- 使用实验性设置 RPC 在轮次后重置：拒绝，因为项目只采用成熟 app-server API，而且额外写入
  会改变 owner 与恢复语义。
