# ADR 0024：手动模式对齐 Codex，自动模式单 turn 广泛放行并保留人工兜底

- 状态：已接受
- 决策日期：2026-08-11
- 取代：[ADR 0023](0023-per-turn-manual-and-auto-execution-environments.md)
- 修订：[ADR 0002](0002-security-gateway-and-manual-approval.zh-CN.md)

## 背景

ADR 0023 把默认手动模式设为 `untrusted + readOnly`，把一次性自动模式设为
`on-request + workspaceWrite`。这两档虽然都保留了人工审批，但与 Codex 常规使用体验相反：
默认模式会让普通命令和工作区修改更早遇到审批边界，而所谓自动模式仍会在 sandbox 越界时
暂停。实际使用中，这造成了过多审批、失败后重试和权限状态猜测。

[OpenAI 官方 sandbox 文档](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)
把 `workspace-write + on-request` 定义为低摩擦的本地自动化组合：工作区内读写与命令自动执行，
sandbox 越界操作请求用户批准；`danger-full-access` 则移除文件系统和网络 sandbox 边界。
`never` 的含义是完全不暂停请求批准，因此它也会让仍需明确确认的权限请求失去人工兜底，不能
满足“普通操作静默执行，但无法自动允许的操作仍可手动通过”的产品要求。

Codex CLI 0.147.0 的稳定 `TurnStartParams` 分别支持 `approvalPolicy` 与 `sandboxPolicy`；
`AskForApproval` 包含 `on-request`，`SandboxPolicy` 包含 `dangerFullAccess`，稳定 server request
还定义了命令、文件、细粒度权限和 MCP elicitation 的人工响应结构，不需要实验性设置 API。

## 决策

- 浏览器直接 `turn/start` 只提交逐字段重建后的
  `executionMode: "manual" | "auto"`，省略时默认为 `manual`。浏览器不得提交 approval、
  reviewer、完整 sandbox、writable roots、network 或 tmp 策略。
- 网关为每个 `manual` turn 注入 `approvalPolicy: "on-request"`、
  `approvalsReviewer: "user"` 和 `workspaceWrite` sandbox。工作区内读写和普通命令直接执行；
  sandbox 尚未开放的网络访问、工作区外写入、受保护的 `.git` 路径及其他 sandbox 越界操作由
  Codex 请求用户审批。用户批准后，Codex 按正常越界执行流程继续该操作。
- 网关为每个显式 `auto` turn 注入 `approvalPolicy: "on-request"`、
  `approvalsReviewer: "user"` 和 `{ type: "dangerFullAccess" }`。文件系统与网络 sandbox 边界被
  移除，所以普通命令、文件和网络操作尽量静默执行；规则、权限工具、MCP 或其他仍需明确确认的
  稳定协议请求继续交给用户，而不是因 `never` 被静默拒绝。
- Ask Codex 对可支持的稳定人工请求逐字段重建响应：命令和文件只能返回 app-server 实际提供的
  决策；细粒度权限只能完整接受上游原请求或拒绝，接受时强制限定为当前 turn；标准 MCP typed
  form 和 HTTP(S) URL elicitation 可以接受或拒绝。无法安全校验的 `openai/form` 会明确展示但
  只能拒绝，未知请求继续失败关闭。
- 新线程 `thread/start` 固定使用 `on-request + workspace-write`；恢复和 fork 固定
  `on-request` 且不接受浏览器 sandbox override。跨设备队列在发送前恢复线程权威状态，并明确按
  `manual` 物化最终 turn 策略。steering 不携带执行策略。
- UI 不展示 read-only、workspace-write 或 Full access 选择。自动开关只允许在已有空闲线程，或
  已配置但尚未创建的新线程草稿上逐轮开启；Working 时锁定为当前 turn 的启动模式。轮次结束、
  取消、失败或启动失败后恢复关闭，切换 session 不得改写已启动 turn 的模式。
- 新线程创建、恢复、fork、队列、steering 和后续普通 turn 不继承一次性自动选择。即使
  app-server 保留上一次 turn override，Ask Codex 也必须为下一次 direct turn 重新提交完整模式。
- `externalSandbox` 的权限由外部环境管理，Ask Codex 无法保证完全放行，因此不为其开放自动
  模式，也不发送 turn sandbox override。
- 浏览器提交 `never`、`granular` 或其他原始策略字段必须被拒绝。不使用实验性设置 RPC、
  permission profile 或其他实验性权限 API。

## 理由

默认手动模式应复制 Codex 用户已经熟悉的行为，而不是创造 Ask Codex 专属的 RO/RW 心智模型。
`on-request + workspaceWrite` 让普通开发工作连续进行，同时把 Git 元数据写入、受限网络访问和
工作区外写入等关键操作留给人工批准。自动模式使用 `dangerFullAccess` 消除最常见的执行边界，
同时保留 `on-request + user` 作为无法自动放行时的人工出口。
它是“尽量自动”，不是对所有未来请求类型承诺绝对无提示；这种语义比 `never` 静默拒绝更符合
交互直觉。

两档策略仍由网关逐 turn 重建，既不让浏览器伪造底层权限，也不把一次性选择变成线程或设备的
持久状态。

## 影响

- 默认手动模式显著减少普通命令和文件修改的审批；例如 `git commit` 写入受保护的 `.git` 时仍会
  请求批准，但用户批准后不应再被 Ask Codex 自身的只读策略拒绝。
- 自动模式比 ADR 0023 风险更高：模型在该 turn 内可以访问网络并读写工作区外路径，通常不会出现
  sandbox 审批。UI 必须保持显式、一次性和运行中不可切换，不得持久化。
- 自动模式仍可能出现规则、细粒度权限或 MCP 确认，这是保留人工兜底的预期行为，不应描述为
  “完全免审批”。
- 队列和下一次普通 direct turn 必须显式恢复 manual，避免 app-server 保存的上一次 full-access
  override 造成权限继承。
- 网关仍有界缓存 app-server 返回的 sandbox 权威状态，用于保留 `workspaceWrite` 细节和识别
  `externalSandbox`；浏览器只看到 sandbox type，也不能修改它。

## 考虑过的替代方案

- 保留 ADR 0023 的 `untrusted + readOnly` 手动模式：拒绝，因为它偏离 Codex 默认体验，并为普通
  开发操作制造过多审批和失败面。
- 手动模式使用 `untrusted + workspaceWrite`：拒绝，因为不受信任命令仍会频繁弹窗，不符合用户
  所说的“关键操作审批、其他自动执行”。
- 自动模式使用 `never + dangerFullAccess`：拒绝，因为 `never` 会抑制仍可由用户处理的请求，
  把可恢复的人工确认变成静默拒绝。
- 自动模式继续使用 `on-request + workspaceWrite`：拒绝，因为常见的工作区外写入和网络边界仍会
  频繁暂停，没有达到广泛自动执行的目标。
- 在 UI 暴露 RO、RW 和 Full access：拒绝，因为产品只需要两档符合 Codex 直觉的逐 turn 模式，
  底层权限组合仍应由网关负责。
- 使用自动审批 reviewer：拒绝，因为它会引入额外审批流程和模型调用，也不能替代用户处理
  无法自动允许的请求。
