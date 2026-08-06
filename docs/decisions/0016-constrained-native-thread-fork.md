# ADR 0016：受限开放原生线程 Fork

- 状态：已接受
- 决策日期：2026-08-06

## 背景

Codex CLI 0.146.0 生成的 experimental schema 已包含 `thread/fork`。请求既可按
`threadId` 或不稳定的 rollout `path` 定位来源，也可指定截断点、模型、cwd、权限、
instructions 和其他运行时覆盖。响应返回新线程、继承后的设置及 `thread.historyMode`。

直接透传这些字段会让浏览器选择宿主机路径和权限，并把尚未纳入产品范围的历史截断、
rollback 或 detached review 语义绑定到客户端。完整历史还可能使 fork 响应超过网关消息
上限。Fork 是无幂等键的持久写操作；断线或超时后不能确认上游是否已经创建新线程。

## 决策

- 浏览器只能提交来源 `threadId`。网关逐字段重建请求，固定
  `approvalPolicy: "on-request"`、`approvalsReviewer: "user"` 和
  `excludeTurns: true`；不接受 `path`、cwd、模型、权限、instructions、截断点或其他覆盖。
- 网关严格验证新 ID 与来源不同、`forkedFromId` 精确匹配来源、响应和线程 cwd 一致且为
  绝对路径、历史模式为 `legacy` 或 `paginated`、审批设置仍由用户持有、sandbox 类型已知，
  且排除历史后的 `turns` 为空。只向浏览器投影界面需要的线程元数据和有效设置，不暴露
  rollout path、instruction sources、runtime workspace roots 或未知字段。
- 只有结构有效的成功结果才把新线程 owner 同步提交给发起连接；来源线程 owner 不变。
  失败、畸形结果、ID 冲突、Codex error 或请求方断线都不改变 owner。
- 客户端只为空闲来源提供显式 Fork 动作。成功后通常选择新线程，并通过现有
  `thread/turns/list` 有界分页路径读取历史；若用户在请求期间已经切换线程，只更新列表，
  不抢回选择。默认和分页历史都沿用 app-server 返回的持久化契约，客户端不选择或迁移模式。
- 成功结果在现有资源上限内把来源线程的进程内结构化 Plan 记录复制到新线程 ID；文件下载
  authority 则只从 fork 响应中新线程的权威 cwd 建立，不继承浏览器提供的范围。
- Fork 不自动重试，也不与 rollback、detached review 或任意历史截断能力捆绑。

## 影响

- 默认与 `paginated` 来源共用同一 fork 和历史恢复流程，长历史不会塞入初始 RPC 响应。
- 浏览器不能从 Fork 获得新的路径、权限或配置注入面；继承的 external sandbox 也不会被覆盖。
- 断线后的未知结果可能留下已由 app-server 创建、但未自动选中的线程。用户可刷新列表确认，
  客户端不会冒险重放并制造重复 fork。
- 当前验证基于 CLI 0.146.0 生成 schema 和确定性的策略、owner、分页及界面测试；为避免产生
  持久测试线程，没有仅为验证而调用真实 `thread/fork`。

## 考虑过的替代方案

- 返回完整 fork 历史：拒绝，因为长线程可能超过消息上限，而且项目已有有界分页读取路径。
- 暴露截断点或 rollout path：拒绝，因为这会扩大产品语义和宿主机路径攻击面。
- fork 后调用 `thread/resume`：拒绝，因为 fork 成功已经建立新线程并返回设置；额外 resume
  会不必要地再次改变 owner，并扩大未知结果窗口。
- 对超时或断线自动重试：拒绝，因为 `thread/fork` 没有幂等键。
