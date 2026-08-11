# ADR 0023：为每个 turn 固定独立的手动或自动执行环境

- 状态：由 [ADR 0024](0024-codex-aligned-manual-and-one-turn-auto.md) 取代
- 决策日期：2026-08-11
- 取代：[ADR 0022](0022-sandbox-aware-one-turn-auto-run.md)
- 修订：[ADR 0002](0002-security-gateway-and-manual-approval.zh-CN.md)

## 背景

ADR 0022 只用 `untrusted` 与 `on-request` 区分普通和自动 turn，sandbox 则沿用线程当时的
设置。稳定 `TurnStartParams` 的 approval 与 sandbox override 会同时影响当前及后续 turn；
因此只切换 approval 会让“手动/自动”依赖线程先前留下的 sandbox 状态，也容易诱使客户端在
发送前通过 `thread/resume` 改 sandbox。后者会扩大线程级状态变化和 owner 影响范围，并可能在
上游没有应用请求值时以 `thread/resume did not apply the requested sandbox` 失败。

用户对两种模式的直觉是执行环境随 turn 启动参数固定：手动模式尽量在命令、修改、联网或其他
越界行为前暂停；自动模式允许当前工作区内的普通操作自动执行，但越过 sandbox 仍必须交给用户。
已启动 turn 不应因浏览器切换到其他 session 或修改下一轮选择而改变。

Codex CLI 0.147.0 的稳定 bindings 表明 `TurnStartParams` 同时支持 `approvalPolicy`、
`approvalsReviewer` 和完整 `sandboxPolicy`。[OpenAI 官方审批与沙箱组合](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations)
把 `untrusted + read-only` 描述为 “Always ask for approval” 配置，并把
`on-request + workspace-write` 描述为自动预设；两者都不需要实验性设置 API。

## 决策

- 浏览器直接 `turn/start` 只提交 `executionMode: "manual" | "auto"`，省略时按 `manual`。
  网关拒绝浏览器提交原始 approval、reviewer、sandbox、writable roots、network 或 tmp 策略。
- 网关为每个 `manual` turn 注入 `approvalPolicy: "untrusted"`、
  `approvalsReviewer: "user"` 和 `{ type: "readOnly", networkAccess: false }`。已知安全的读取仍可
  执行；命令、修改、联网和其他需要越过该边界的操作必须产生用户可处理的审批。
- 网关为每个 `auto` turn 注入 `approvalPolicy: "on-request"`、
  `approvalsReviewer: "user"` 和权威 `workspaceWrite` policy。当前工作区内的读写和命令可自动
  执行；工作区外写入、受限网络和其他 sandbox 越界请求仍由用户审批。
- `workspaceWrite` 的 writable roots、network 及 tmp 选项只能来自严格校验后的 app-server
  `thread/start`、`thread/resume`、`thread/fork` 结果或 `thread/settings/updated` 通知。网关在
  进程内最多缓存 4096 个线程的权威状态；缺失时先执行一次不带 sandbox override 的安全
  `thread/resume` 探测。若只知道 `readOnly`，自动 turn 使用不添加额外 writable roots、关闭
  network 的默认 `workspaceWrite` policy。浏览器只看到 sandbox type。
- 明确配置的 `dangerFullAccess` 保持原样，`externalSandbox` 不接收 turn sandbox override；两者
  都不开放自动开关，网关也拒绝伪造的 `auto` 请求。用户主动选择 Full access 的语义不被
  手动/自动模式暗中撤销。
- 自动模式不得先调用 `thread/resume` 修改 sandbox。普通恢复仍可用于显式选择线程和同步，用户
  在设置对话框主动修改 sandbox 时也可使用既有的安全恢复流程。
- 自动选择仍是当前页面内、逐 turn 的一次性选择。Working 时锁定为活跃 turn 启动时捕获的
  模式；跨 session 查看不得丢失或覆盖。轮次结束、取消、失败或启动失败后恢复默认手动模式。
  新线程创建、恢复、fork、队列消费和 steering 不继承该选择。
- 不使用实验性的设置 RPC、WebSocket app-server transport、permission profile 或其他实验性 API。
  不支持的细粒度权限与 MCP elicitation 继续失败关闭。

## 理由

approval 决定何时暂停，sandbox 决定无需额外授权时能做什么；把两者作为一个逐 turn 产品模式
才能形成稳定直觉。最终参数由网关根据 app-server 权威状态重建，既避免浏览器伪造 writable
roots 或 network 权限，也避免把一次性自动选择实现成线程级 resume 变更。

## 影响

- 默认手动 turn 比 ADR 0022 更严格：工作区写入和命令执行会落到只读边界，已知安全读取仍可能
  自动进行，因此产品不得承诺“所有读取动作都弹窗”。
- 自动 turn 可在工作区内连续工作，sandbox 越界仍沿现有 owner 路由显示给用户。
- app-server 把 turn override 记为后续设置并不造成模式继承；Ask Codex 的下一次直接 turn 会
  再次显式发送完整的手动或自动组合。
- 网关需要保存有界的 sandbox authority，并在转发生命周期结果与设置通知时剥离 writable roots、
  network 和 tmp 细节。

## 考虑过的替代方案

- 保留 ADR 0022，仅切换 `untrusted` 与 `on-request`：拒绝，因为它不能为每个 turn 固定可写范围，
  也不能保证文件修改遵循手动模式的只读边界。
- 开启自动模式时先用 `thread/resume` 切到 `workspace-write`：拒绝，因为它改变线程级状态，扩大
  owner 与失败面，并重现已经观察到的 sandbox override 不一致错误。
- 让浏览器提交完整 `sandboxPolicy`：拒绝，因为浏览器不是 writable roots、network 或 tmp
  权限的权威来源。
- 把自动模式持久保存在 thread、页面或设备：拒绝，因为用户接受的是逐 turn 显式选择。
- 使用实验性设置或 permission profile API：拒绝，因为成熟的稳定 `turn/start` 字段已足够。
