# 架构决策记录

架构决策记录（ADR）用于保存项目的长期决策及其理由。只需阅读与当前任务相关的记录。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-codex-app-server-stdio.zh-CN.md) | 已接受 | 通过 JSONL stdio 使用有文档支持的 Codex app-server 协议。 |
| [0002](0002-security-gateway-and-manual-approval.zh-CN.md) | 已接受 | 将网关维持为严格的策略边界，并强制执行人工审批。 |
| [0003](0003-cloudflare-access-dual-gate.zh-CN.md) | 已接受 | 将 Cloudflare Access 与 Ask Codex 令牌作为彼此独立的远程访问关卡。 |
| [0004](0004-versioned-project-context.zh-CN.md) | 已接受 | 在纳入版本控制的文档中维护简明的跨设备开发上下文。 |
| [0005](0005-thread-and-turn-settings.zh-CN.md) | 已接受；由 0006 修订 | 将线程身份和沙箱设置与下一轮的模型控制分开。 |
| [0006](0006-configured-turn-defaults.zh-CN.md) | 已接受 | 修订模型默认值，使其采用经过筛选的 Codex 有效配置。 |
| [0007](0007-document-language.md) | 已接受 | 以简体中文作为项目文档的主要语言，并维护对应英文版本。 |
| [0008](0008-paginated-thread-history.md) | 由 0010 取代 | 新线程使用分页历史，并以条目页恢复超大轮次。 |
| [0009](0009-temporary-image-attachments.md) | 已接受 | 通过受限的临时 HTTP 附件和一次性 ID 向 Codex 提交图片。 |
| [0010](0010-app-server-default-thread-history.md) | 已接受 | 新线程使用 app-server 的默认历史契约，同时保留分页线程的只读恢复能力。 |
| [0011](0011-browser-local-image-previews.md) | 已接受 | 在同一浏览器配置文件和 Origin 的 IndexedDB 中有界保留已发送图片的预览。 |
| [0012](0012-read-only-connection-recovery.md) | 已接受 | 通过只读快照恢复连接，不后台认领线程或重放未确认写请求。 |
| [0013](0013-thread-working-directory-defaults-and-file-download-scope.md) | 已接受 | 将所选线程的 Working directory 用作新线程默认上下文和受限文件下载范围。 |
| [0014](0014-bounded-structured-plan-recovery.md) | 已接受 | 通过有界网关快照恢复结构化 Plan，并区分可恢复、不可恢复和未知状态。 |
| [0015](0015-explicit-active-turn-steering.md) | 已接受 | 将显式文本 steering 绑定到确切活跃轮次，并保持严格确认、owner 和不重放语义。 |
| [0016](0016-constrained-native-thread-fork.md) | 已接受 | 仅按来源线程 ID 开放原生 fork，并严格约束参数、结果、owner 与不重放语义。 |
| [0017](0017-constrained-file-input-and-browser-local-copies.md) | 已接受 | 通过临时网关上下文提交普通文件，并仅在同源浏览器中有界保留下载副本。 |

英文索引见 [README.en.md](README.en.md)。

## 生命周期

每份 ADR 的状态为 `提议`、`已接受`、`已拒绝`、`已弃用` 或 `已取代`。已接受的记录属于历史记录；决策发生变化时，不得删除或重写这些记录。应新增一份替代 ADR，将较早的记录标记为“由 ADR NNNN 取代”，并在两份记录之间互相链接。

当架构、安全、协议、依赖、产品或工作流程方面存在具有实质性替代方案的长期选择时，应使用 ADR。不要为常规实现变更或临时任务规划创建 ADR。
