# ADR 0026：app-server JSONL 不设固定行上限，浏览器投影继续有界

- 状态：已接受
- 决策日期：2026-08-14
- 扩展：[ADR 0001](0001-codex-app-server-stdio.zh-CN.md)、[ADR 0010](0010-app-server-default-thread-history.md)

## 背景

Ask Codex 原先在读取 `codex app-server` stdout 时，把单条 JSONL 行限制为 8 MiB；超过后会终止
app-server 子进程。实测长命令输出会被 app-server 累积到完整 `commandExecution.aggregatedOutput`，
并可能再次出现在 `item/completed`、`turn/completed`、`turn/start` 或历史读取结果中。一条消息因此
可以超过 8 MiB，使网页停止接收后续生命周期事件，并把正常运行的线程中断。

官方 app-server 协议规定 stdio 传输是一条 JSON-RPC 消息一行的 JSONL，但没有规定 8 MiB
行上限。模型 context window 与本地协议消息的序列化字节数也是不同资源：上下文压缩不会保证
历史 RPC 或完成通知中的命令输出小于某个传输阈值。

浏览器边界仍需要明确预算。浏览器不应接收数 MiB 的重复累计工具输出，也不应因一个大响应让
Node 事件循环长时间复制、清洗和序列化完整对象。

## 决策

- 受信任的 `codex app-server` stdout JSONL 默认不设固定单行字节上限。读取器按需扩展缓冲区，
  完成大行后缩回初始容量；显式 `maxStdoutLineBytes` 只保留为测试和诊断注入能力。
- 对超过 1 MiB 的 app-server stdout 行记录仅含元数据的诊断：方向、关联 RPC method、消息和
  线程/轮次/条目标识、最大字符串路径与类别、顶层字符串字节统计，以及图片/base64 标记。
  如果响应本身没有线程标识，method 请求中的有界 `threadId`/`turnId`/`itemId` 只用于诊断关联。
  日志不得包含正文、命令输出、MCP 参数或凭据。
- app-server 到浏览器的 WebSocket 消息继续保持 1 MiB 上限。在递归清洗和 `JSON.stringify`
  之前做有界大小估算，避免先复制完整大对象。
- 超大的条目生命周期通知保留 ID、类型、状态、命令元数据、退出信息和 omission 计数；不重复
  发送完整累计输出。超大的轮次生命周期通知保留 ID、状态和时间，并标记 items 未加载。
- 超大的历史、恢复和 `turn/start` 结果先投影为有界摘要；若摘要仍过大，再降级为只含轮次壳、
  状态、时间、游标和 omission 数量的投影。无法证明结构有效或无法降到预算内时，返回小型 RPC
  错误，不关闭浏览器连接或 app-server。
- `turn/plan/updated` 继续由既有 Plan 缓存的字段和大小规则处理。超限 Plan 写入不可恢复
  tombstone 并发送 `planUnavailable`，不能被通用大消息告警替代。
- 前端把压缩完成通知中的 omission 与已经流式收到的内容合并，不允许摘要覆盖已有输出。

## 理由

固定 8 MiB 上限约束的是 wrapper 的实现，不是上游协议；用它终止共享 app-server 会把一个大
但合法的消息升级成所有浏览器都可见的线程中断。把受信任的本地协议读取与不受信任、可能较慢
的浏览器传输分成两个资源边界，可以保留协议兼容性，同时继续控制浏览器内存、序列化停顿和
网络背压。

## 影响

- 大命令输出或长历史不再仅因单条 stdout JSONL 超过 8 MiB 而终止 app-server 和活跃线程。
- 浏览器可能看到摘要、omission 提示或要求重新同步，而不是完整累计输出；实时流中已经收到的
  有界前缀会保留。
- app-server 仍可发送很大的单条合法消息，因此网关瞬时内存取决于该行大小。元数据诊断用于
  确认真实来源；无固定上限不等于允许浏览器或外部客户端提交无界消息。
- 压缩历史可能无法从被省略的 Agent 正文中签发文件下载 capability；该能力失败关闭，用户可
  通过更小的原生分页结果恢复完整条目时再获得链接。

## 考虑过的替代方案

- 提高固定 stdout 上限：未采用，因为 16、32 或 64 MiB 仍是与协议无关的任意终止点，不能解决
  更大合法结果。
- 同时取消浏览器 1 MiB 上限：拒绝，因为这会把重复累计输出、主线程序列化停顿和慢客户端背压
  直接转移到每台设备。
- 对所有大消息只发送 `gateway/resyncRequired`：未采用，因为会丢失 `item/completed` 和
  `turn/completed` 的完成状态，正是网页长期显示 running 的原因。
- 依赖模型上下文压缩控制消息大小：拒绝，因为模型上下文和 app-server JSON-RPC 序列化是两个
  不同层次，命令输出与历史对象仍可独立增长。
