# ADR 0018：服务端持久且显式消费的跨设备消息队列

- 状态：已接受
- 决策日期：2026-08-07
- 扩展：[ADR 0002](0002-security-gateway-and-manual-approval.zh-CN.md)、[ADR 0012](0012-read-only-connection-recovery.md)
- 不改变：[ADR 0015](0015-explicit-active-turn-steering.md)

## 背景

用户需要在一个浏览器或设备上准备文字，稍后在另一个设备上把它发送到同一个 Codex 原生
线程。浏览器本地草稿无法跨设备，而连接恢复也刻意不重放结果未知的 `turn/start`。如果把
队列简单实现成断线后的自动重试，网络中断可能重复创建轮次，还可能在没有活跃浏览器承担
审批时后台执行。

Codex CLI 0.147.0 的稳定 bindings 包含 `turn/start.clientUserMessageId`，但生成的 schema
没有定义重复键的作用域、持久期、相同键不同 payload 的处理或跨进程行为，因此不能把字段
存在等同于已经验证的幂等保证。稳定的 `thread/inject_items` 只追加原始 Responses API 历史
项，不创建正常轮次，也不提供本产品所需的确认和审批 owner 语义。实验性 remote-control、
实时或其他协议也不应成为第一版队列的依赖。

## 决策

- 队列是 Ask Codex 自有的、服务端持久化的文本 outbox，不是 Codex 原生线程历史。第一版只
  接受已有线程 ID、一段非空纯文本和入队时最后可见的轮次 ID；不接受附件、路径、cwd、
  `additionalContext`、模型、effort、sandbox 或原始 app-server 参数。
- 浏览器只能调用逐字段重建的本地 RPC：`messageQueue/list`、`messageQueue/enqueue`、
  `messageQueue/cancel` 和 `messageQueue/send`。列表按线程读取；取消和发送都必须带当前 item
  revision，以阻止两个设备基于陈旧快照同时操作。网关通过不含消息正文的
  `messageQueue/changed` 通知让其他已认证浏览器重新读取。
- 只有一个已连接且完成只读同步的浏览器显式点击发送时才消费队列。网关不会在定时器、启动、
  WebSocket 重连、Codex ready 或后台线程刷新时自动发送，也绝不把队列项转换成
  `turn/steer`。成功发送该项的浏览器成为后续审批 owner。
- 持久状态为 `queued -> claimed -> dispatching -> confirmed`。上下文变化、线程忙、读取不可用
  或已知的上游拒绝进入 `needsReview`；用户必须基于新 revision 再次明确确认。
  `turn/start` 已进入可能执行但未取得有效响应时进入 `indeterminate`，不能重新入队或再次发送，
  只能在用户核对原生线程后移除。取消、过期和确认分别进入 `cancelled`、`expired` 和
  `confirmed`。
- `claimed` 是尚未跨过 `turn/start` 文本发送边界的短租约；其中可以执行稳定的
  `thread/read` 和 `thread/resume` 准备。由于队列文字尚未提交，网关重启时可安全恢复为
  `queued`。`dispatching` 表示已经跨过该写操作边界，重启时必须恢复为 `indeterminate`。
  每次状态转换先原子持久化，再继续下一步；系统不根据通知、时间或推测把未知结果改回可发送状态。
- 发送前在同线程的 ownership 写操作串行区内，用稳定的 `thread/read` 且
  `includeTurns: true` 核对线程 ID、运行状态和最后轮次 ID。线程 active/system-error 时阻止
  发送；最后轮次变化时进入 `needsReview`。用户明确确认上下文变化后可以再次尝试，但不能绕过
  线程忙检查。当前协议没有跨 app-server 进程的 revision/CAS，因此该检查只能缩小竞态窗口，
  不能提供跨进程原子性。
- 真正发送前，用稳定的 `thread/resume` 且 `excludeTurns: true` 保证线程已加载，并在 resume
  和 `turn/start` 中都固定 `approvalPolicy: "on-request"` 与
  `approvalsReviewer: "user"`，不提交 sandbox 覆盖，从而保留已有 `externalSandbox`。
  `turn/start` 只包含一项纯文本输入。只有结构有效的 `TurnStartResponse` 才进入 `confirmed`。
- 第一版不提交 `clientUserMessageId`，也不使用 `thread/inject_items`。只有上游正式文档或受控
  验证明确证明幂等键的重复处理、作用域、持久期和 payload 冲突行为后，后续 ADR 才能授权
  对 `indeterminate` 项进行有界重试。
- 持久化使用 Node.js 22 已成熟的文件系统 API，以同目录临时文件、文件 `fsync`、原子
  `rename` 和目录 `fsync` 提交完整版本化 JSON。默认路径是
  `$XDG_STATE_HOME/ask-codex/message-queue.json`，未设置 XDG 目录时使用
  `~/.local/state/ask-codex/message-queue.json`；可通过绝对的 `ASK_CODEX_QUEUE_PATH` 覆盖。
  一个队列文件只允许一个 Ask Codex 网关进程使用。
- 单项文本最多 64 KiB UTF-8；最多 64 个活跃项、128 条总记录和 4 MiB 文件。活跃项 7 天
  过期，`confirmed`、`cancelled` 和 `expired` 终态最多保留 24 小时后清理。目录和文件分别按
  `0700` 与 `0600` 创建；未知版本、畸形结构、重复 ID 或超限文件启动时失败关闭，而不是静默
  丢弃用户尚未发送的内容。

## 理由

服务端 outbox 才能跨浏览器和设备保留草稿；显式消费则保留了用户对执行时机和审批责任的
控制。把本地 claim/revision 去重与上游未知结果分开，可以阻止同一网关内的并发双发，又不会
假装当前 app-server 已经提供端到端 exactly-once。使用成熟的原子文件替换避免为单进程、
有界队列引入额外数据库依赖，也保持 Node.js 22.12 的现有运行基线。

## 影响

- 一个设备入队的纯文本会由网关持久保存，并可在另一个已认证设备的同一线程面板中看到、
  发送或取消。
- 网关或网络在写边界附近失败时，用户可能需要先检查原生线程再清理 `indeterminate` 项；系统
  宁可要求人工判断，也不重复执行。
- 上下文检查需要一次可能较大的稳定 `thread/read(includeTurns: true)`。读取失败或响应结构
  不可信时不会发送；超长旧线程可能因此需要先由用户正常打开和整理，而不是降低验证强度。
- 队列保存用户文字明文，权限等同于运行 Ask Codex 的操作系统账户。它不保存 token、附件、
  路径、工具输出或审批内容。
- 该存储不是多进程数据库。两个网关不能共享同一路径；跨主机同步仍不在范围内。

## 考虑过的替代方案

- 仅保存浏览器 IndexedDB 草稿：未采用，因为不能跨设备。
- 网关无浏览器参与时自动启动轮次：拒绝，因为会改变执行时机并留下无人承担的审批。
- 将队列项自动转换成活跃轮次的 `turn/steer`：拒绝，因为 steering 绑定确切轮次，语义不同。
- 对超时的 `turn/start` 自动重试：拒绝，因为 `clientUserMessageId` 的幂等语义尚未得到正式
  证明，字段存在本身不足以授权重放。
- 使用 `thread/inject_items`：拒绝，因为它修改模型可见历史而不是创建正常轮次，并绕过标准
  的执行、确认和 owner 流程。
- 使用 `node:sqlite` 或第三方数据库：第一版未采用，因为项目支持 Node.js 22.12，且单进程
  有界状态机可由成熟的原子文件 API 满足。需要多进程写入或更大审计查询时再另行决策。
