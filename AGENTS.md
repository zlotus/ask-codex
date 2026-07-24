# AGENTS.md

[English](AGENTS.en.md) | 简体中文

## 项目范围

Ask Codex 是一个面向单用户、本地优先的 Codex 浏览器客户端。集成必须基于有文档的
`codex app-server` JSONL-over-stdio 协议。不要依赖 Codex Desktop 的私有 IPC，
也不要暴露终端界面。

## 文档语言

- 简体中文是项目文档的默认语言；普通文档以默认 `.md` 文件作为中文主版本，并以
  对应的 `.en.md` 文件保存英文镜像。
- 不要改写历史上已经接受的 ADR 原件；英文 ADR 的中文译本使用 `.zh-CN.md` 后缀。
- 后续新 ADR 以中文起草，并提供对应的 `.en.md` 英文镜像。
- 文档发生语义变更时，同一变更必须同步更新中英文版本。

## 架构

- `src/`：React 浏览器界面、协议归一化、流式状态和审批。
- `server/`：Express/WebSocket 网关以及 `codex app-server` 子进程。
- `server/rpc-policy.ts`：浏览器到 Codex 的完整 RPC 允许列表。
- `server/server-request-policy.ts`：浏览器对 app-server 请求的响应策略。
- `scripts/visual-check.mjs`：桌面端和移动端生产界面冒烟测试。

## 项目上下文

进行非简单工作或恢复开发时，先阅读 `docs/context.md` 和
`docs/progress.md`，然后只阅读 `docs/decisions/README.md` 所链接且与任务相关的
ADR。只有在产品规划期间才阅读 `docs/ideas.md`。

将已安装 CLI 生成的 schema 视为协议事实来源，将本文件中的安全不变量视为规范性要求，
并将代码、测试和配置视为已实现行为的事实来源。如果这些来源与文档不一致，应验证实际
行为，并在同一变更中更新过时文档。

保持 `docs/context.md` 稳定，并让 `docs/progress.md` 作为简洁的当前状态快照，
而不是变更日志或任务日记。对持久的架构、安全、协议、依赖、产品或工作流决策，使用带日期
的 ADR 记录。保留已经接受的决策；如需替换，应创建新的 ADR，并将旧 ADR 标记为已取代。

不要因为常规编辑、格式调整、小型孤立修复或尚未成为已接受决策的探索性讨论而更新项目
上下文文档。只记录实际执行过的验证。

## 安全不变量

- 绝不暴露任意 app-server RPC 方法，也不要直接透传浏览器参数；必须根据允许列表重新构建参数。
- 在网关强制保持 `approvalPolicy: "on-request"` 和
  `approvalsReviewer: "user"`。
- 绝不将 `ASK_CODEX_TOKEN` 放进 URL，也不要把它传给 Codex、MCP 服务器、hook
  或命令。WebSocket 认证在第一条消息帧中完成。
- 保持默认仅监听回环地址、严格的 Origin/Host 检查、连接和请求限制，以及非回环地址必须
  配置令牌的要求。
- 将 `ASK_CODEX_PUBLIC_ORIGIN` 视为唯一且精确的可信代理 Origin；只要配置了它，
  就必须要求令牌，并在代理中保留公网 `Host`。
- 将 `ASK_CODEX_WORKSPACE` 视为初始目录，而不是访问边界。
- 不支持的细粒度权限授予和 MCP elicitation 必须默认拒绝。
- 恢复会话时保留已有的 `externalSandbox`，不要覆盖它。

## 协议变更

已安装的 CLI 定义协议。Codex 发生变化时，在仓库之外生成当前绑定，并比较相关的请求、
响应、通知和联合类型结构：

```bash
schema_dir="$(mktemp -d)"
codex app-server generate-ts --experimental --out "$schema_dir"
```

同时更新归一化逻辑和针对性测试。尤其要验证会话设置、带索引的推理部分、计划增量、文件
变更种类、分页、新旧审批机制以及 `request_user_input` 响应。

## 验证

提交实现变更前运行：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

对于界面变更，在 4173 端口启动生产构建，并运行 `npm run check:visual`。除非用户已授权
由此产生的 API 用量和会话变更，否则不要仅为了界面冒烟测试而创建真实的 Codex 轮次。
