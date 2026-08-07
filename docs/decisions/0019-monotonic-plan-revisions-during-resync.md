# ADR 0019：用单调 revision 裁决重同步期间的 Plan 快照

- 状态：已接受
- 决策日期：2026-08-07
- 扩展：[ADR 0014](0014-bounded-structured-plan-recovery.md)

## 背景

ADR 0014 让网关缓存最新的完整 `turn/plan/updated`，并在只读重同步快照中附加该 Plan。
浏览器重同步时会缓冲同时到达的实时通知；此前只要快照中的轮次带有 `plan` 字段，就把该轮次
所有缓冲 Plan 通知视为已覆盖。

这个判断缺少顺序证据。快照请求读取到缓存后、响应到达浏览器前，网关可能先收到一份更新的
Plan 并把它作为实时通知放入浏览器缓冲区。旧快照随后完成时会错误丢弃这份较新通知，使 Plan
面板停在旧步骤，直到 Codex 再发下一份 Plan。网络从 Working 经 Retry 到 Sync 的过程会扩大
该竞态窗口，因此现象与重连高度相关，但根因不是 Codex 停止更新 Plan。

## 决策

- 网关对每一份观察到的 Plan 更新分配进程内单调递增的正 safe-integer revision。合法 Plan
  和表示最新 Plan 不可恢复的 tombstone 都获得 revision。
- 同一 revision 随网关的逐字段投影同时附加到实时通知和缓存恢复快照，字段名为
  `askCodexPlanRevision`。该字段是 Ask Codex 的网关元数据，不属于上游 app-server 协议，
  也不会发送给 Codex。
- 重同步只在通知和快照都带合法 revision，且通知 revision 小于等于快照 revision 时，才把
  缓冲通知判定为已覆盖。revision 更大的通知必须按原到达顺序重放。
- 缺少或非法 revision 时不推断覆盖关系。为兼容旧网关、预算降级和未知缓存状态，未版本化的
  缓冲通知继续重放；带 `plan` 但没有合法 revision 的快照仍可按原有三态规则合并。
- 浏览器把 revision 与对应 Plan 一起保存。缺少 `plan` 的稀疏轮次快照保留既有 Plan 与
  revision；明确的 Plan 对象或 tombstone 则更新二者。网关进程重启会同时丢失缓存和计数器，
  因此 revision 不作为跨进程持久身份，也不用于不同网关实例之间比较。
- 传输到达顺序继续是权威顺序；`emittedAtMs` 和 `gatewayReceivedAtMs` 仍只用于诊断，不参与
  冲突裁决。

## 理由

revision 在产生缓存快照和实时通知的同一网关内分配，直接表达两者的先后关系。它可以在不
调用影响 owner 的 RPC、不依赖时钟同步、也不持久化 Plan 的前提下区分“快照已经包含的旧通知”
与“快照读取之后才到达的新通知”。缺少 revision 时选择重放，可能短暂重复应用或回放较旧的
完整 Plan；通知仍保持原到达顺序，因此最终不会把较新进度静默丢弃。

## 影响

- Working -> Retry -> Sync 期间到达的新 Plan 不再被较旧的重同步快照吞掉，面板会继续采用
  网关实际观察到的最新进度。
- 该修复不让客户端推断 Codex 的执行进度；如果 Codex 没有发出新 Plan，步骤仍会保持不变。
- 每条可恢复 Plan 增加一个小型整数元数据，缓存字节预算继续包含它。revision 接近
  `Number.MAX_SAFE_INTEGER` 时网关失败关闭；在单个进程生命周期内实际不可达。
- 方案只使用 Ask Codex 本地投影和稳定 app-server 通知，不引入实验性 Codex API。

## 考虑过的替代方案

- 继续让任意带 Plan 的快照覆盖所有缓冲通知：拒绝，因为无法证明快照比通知新。
- 即使已有可信 revision 仍一律重放全部缓冲 Plan：能避免停滞，但会让已证明被覆盖的旧通知
  覆盖更新快照，形成相反方向的回退。
- 用客户端或服务器时间戳比较：拒绝，因为这些时间只适合诊断，不能可靠表示缓存读取边界。
- 持久化全局 revision 或 Plan：未采用；本次竞态只发生在同一网关进程的重同步窗口，ADR 0014
  的进程内、有界缓存边界保持不变。
