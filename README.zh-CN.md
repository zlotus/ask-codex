# Ask Agent

[English](README.md) | 简体中文

Ask Agent 是一个本地优先的 Codex 浏览器客户端。它通过官方
`codex app-server` 协议工作，不包装终端界面，也不修改 Codex 桌面应用。

```text
浏览器界面  <->  Ask Agent 网关  <->  codex app-server  <->  你的工作区
                WebSocket          基于标准输入输出的 JSONL
```

网关将 Codex 进程和本地凭据保留在宿主机上。浏览器可以接收会话、轮次、
工具、命令、差异和审批事件的流式更新，但不会获得一个通用文件服务接口。

## 功能

- 创建、搜索、恢复和刷新 Codex 会话。
- 流式展示 Agent 消息、推理摘要、计划、命令输出、文件变更、MCP 调用和轮次差异。
- 在浏览器中审核命令与文件变更请求。
- 回答 `request_user_input` 发出的结构化问题。
- 选择模型、推理强度、沙箱和绝对工作目录。
- 中断正在执行的轮次。
- 支持桌面端与移动端响应式布局。
- 支持可选的网页访问令牌、Origin 检查，并默认仅监听回环地址。

## 环境要求

- Node.js 22.12 或更高版本。
- 支持 `codex app-server` 的较新 Codex CLI。
- 已完成 Codex 登录；如尚未登录，请先运行 `codex login`。

app-server 自带的 WebSocket 传输仍属于实验功能。Ask Agent 在自己的浏览器网关
后使用更成熟的 JSONL 标准输入输出传输。

## 开发

```bash
npm install
ASK_AGENT_WORKSPACE=/项目的绝对路径 npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 提供前端页面，并将 API 和 WebSocket
流量代理到 `127.0.0.1:4173` 上的网关。

## 生产运行

```bash
npm run build
ASK_AGENT_WORKSPACE=/项目的绝对路径 npm start
```

打开 `http://127.0.0.1:4173`。

配置项：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ASK_AGENT_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `ASK_AGENT_PORT` | `4173` | 网关端口 |
| `ASK_AGENT_WORKSPACE` | 服务进程的工作目录 | Codex 初始绝对工作目录 |
| `ASK_AGENT_TOKEN` | 未设置 | 浏览器访问令牌；监听非回环地址时必须设置 |
| `CODEX_BIN` | `codex` | Codex CLI 可执行文件 |

## 远程访问

不要将本服务直接暴露到公网。任何可以使用该界面的人都可以指示 Codex 读取文件、
修改所选工作区、运行命令，以及提出扩大访问权限的请求。

请把 `ASK_AGENT_TOKEN` 当作运行 Ask Agent 的操作系统账户密码。
`ASK_AGENT_WORKSPACE` 只负责选择初始目录，并不是访问边界。通过认证的浏览器可以
选择其他绝对目录，也可以在经过 Codex 审批后选择完全访问沙箱模式。

需要从其他设备访问时：

1. 设置一个足够长的随机 `ASK_AGENT_TOKEN`。
2. 使用 `ASK_AGENT_HOST` 监听私有网络接口。
3. 将服务置于 TLS 和带认证的反向代理、VPN 或 SSH 隧道之后。
4. 确保代理与应用日志不会记录 Authorization 请求头或 WebSocket 消息体。
5. 保持 Codex 沙箱开启，并检查每次提权请求中的工作目录和会话级权限详情。

未设置令牌时，服务会拒绝监听非回环地址。本工具面向单用户；令牌只是访问门禁，
不提供多用户隔离或基于角色的权限控制。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run lint
# 先在 4173 端口启动生产服务，再运行：
npm run check:visual
```

Codex 协议随已安装的 CLI 版本变化。升级 Codex 后，请运行上述检查，并对会话恢复、
命令审批和文件审批流程进行冒烟测试。

## 为什么不直接复用 `pi-web` 或 `codex-web`？

`pi-web` 直接嵌入 pi Agent SDK 及其会话模型，因此不能在不替换事件层和审批层的
情况下直接换成 Codex 后端。当前的 `0xcaff/codex-web` 会复用经过补丁修改的
Codex Desktop Electron 包和私有 IPC。Ask Agent 改为面向有文档的 app-server
接口，因此集成面更小，也不需要重新分发桌面应用。

底层会话、轮次、条目和审批协议请参阅官方
[Codex app-server 文档](https://developers.openai.com/codex/app-server/)。
