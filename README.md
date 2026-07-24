# Ask Codex

[English](README.en.md) | 简体中文

Ask Codex 是一个本地优先的 Codex 浏览器客户端。它通过官方
`codex app-server` 协议工作，不包装终端界面，也不修改 Codex 桌面应用。

```text
浏览器界面  <->  Ask Codex 网关  <->  codex app-server  <->  你的工作区
                WebSocket          基于标准输入输出的 JSONL
```

网关将 Codex 进程和本地凭据保留在宿主机上。浏览器可以接收会话、轮次、工具、
命令、差异和审批事件的流式更新，但不会获得通用文件服务接口。

## 功能

- 创建、搜索、恢复和刷新 Codex 会话。
- 增量加载长会话历史；新会话使用分页历史，可按条目恢复超大轮次，旧历史则保留有界
  降级处理。
- 流式展示 Agent 消息、推理摘要、计划、命令输出、文件变更、MCP 调用和轮次差异。
- 展示带复制与换行控制的语法高亮代码块、统一或分栏差异，以及分组、可折叠且输出有界的工具活动。
- 在浏览器中审核命令与文件变更请求，并在本次浏览器会话中把审批理由保留在对应命令上。
- 回答 `request_user_input` 发出的结构化问题。
- 新建会话时选择绝对工作目录和沙箱，并在输入框旁选择下一轮使用的模型与推理强度。
  初始选择来自 Codex 的有效配置，其他选项来自 `model/list`。
- 中断正在执行的轮次。
- 支持桌面端与移动端响应式布局。
- 支持可选的网页访问令牌、Origin 检查，并默认仅监听回环地址。

## 界面截图

### 桌面端

![Ask Codex 桌面端界面](docs/screenshots/desktop.png)

### 移动端

<img src="docs/screenshots/mobile.jpg" alt="Ask Codex 移动端界面" width="390">

## 环境要求

- Node.js 22.12 或更高版本。
- 支持分页线程历史的较新 Codex CLI；当前实现已使用 0.145.0 验证。
- 已完成 Codex 登录；如尚未登录，请先运行 `codex login`。

app-server 自带的 WebSocket 传输仍属于实验功能。Ask Codex 在自己的浏览器网关后
使用更成熟的 JSONL-over-stdio 传输。

## 开发

```bash
git clone https://github.com/zlotus/ask-codex.git
cd ask-codex
npm install
ASK_CODEX_WORKSPACE=/absolute/path/to/project npm run dev
```

打开 `http://127.0.0.1:5173`。Vite 提供前端页面，并将 API 和 WebSocket
流量代理到 `127.0.0.1:4173` 上的网关。

## 生产运行

```bash
npm run build
ASK_CODEX_WORKSPACE=/absolute/path/to/project npm start
```

打开 `http://127.0.0.1:4173`。

配置项：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ASK_CODEX_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `ASK_CODEX_PORT` | `4173` | 网关端口 |
| `ASK_CODEX_WORKSPACE` | 服务进程的工作目录 | Codex 初始绝对工作目录 |
| `ASK_CODEX_TOKEN` | 未设置 | 浏览器访问令牌；监听非回环地址时必须设置 |
| `ASK_CODEX_PUBLIC_ORIGIN` | 未设置 | 允许可信反向代理转发的唯一外部 Origin；设置后必须同时设置 `ASK_CODEX_TOKEN` |
| `CODEX_BIN` | `codex` | Codex CLI 可执行文件 |

## 远程访问

不要将本服务直接暴露到公网。任何可以使用该界面的人都可以指示 Codex 读取文件、
修改所选工作区、运行命令，以及提出扩大访问权限的请求。

请把 `ASK_CODEX_TOKEN` 当作运行 Ask Codex 的操作系统账户密码。
`ASK_CODEX_WORKSPACE` 只负责选择初始目录，并不是访问边界。通过认证的浏览器可以
在新建会话时选择其他绝对目录，也可以在经过 Codex 审批后选择完全访问沙箱模式。

需要从其他设备访问时：

1. 设置一个足够长的随机 `ASK_CODEX_TOKEN`。
2. 使用 `ASK_CODEX_HOST` 监听私有网络接口。
3. 将服务置于 TLS 和带认证的反向代理、VPN 或 SSH 隧道之后。
4. 确保代理与应用日志不会记录 Authorization 请求头或 WebSocket 消息体。
5. 保持 Codex 沙箱开启，并检查每次提权请求中的工作目录和会话级权限详情。

未设置令牌时，服务会拒绝监听非回环地址。本工具面向单用户；令牌只是访问门禁，
不提供多用户隔离或基于角色的权限控制。

### Cloudflare Tunnel

完整的端到端配置，包括 Cloudflare Access、MFA 首次注册、App Launcher 引导、
验证和故障排查，请参阅
[Cloudflare Tunnel 私有部署指南](docs/cloudflare-tunnel.md)。

使用 Cloudflare Tunnel 时，Ask Codex 仍可只监听回环地址，无需监听
`0.0.0.0`，也无需在路由器上开放端口：

```bash
# 请先将一个强随机值加载到 ASK_CODEX_TOKEN。
ASK_CODEX_HOST=127.0.0.1 \
ASK_CODEX_PORT=4173 \
ASK_CODEX_PUBLIC_ORIGIN=https://codex.example.com \
ASK_CODEX_TOKEN="$ASK_CODEX_TOKEN" \
npm start
```

`ASK_CODEX_PUBLIC_ORIGIN` 必须是一个完整的 `http://` 或 `https://` Origin，
不能包含路径、查询参数、片段或登录凭据。

将 Tunnel 指向这个本机服务：

```yaml
ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:4173
  - service: http_status:404
```

请保留请求原始的公网 `Host`。尤其不要把 Cloudflare Tunnel 的
`httpHostHeader` 配置成 `localhost` 或 `127.0.0.1`；Ask Codex 会根据
`ASK_CODEX_PUBLIC_ORIGIN` 同时校验 `Host` 和 `Origin`。请配置 Cloudflare
Access，仅允许你自己的身份访问该域名并强制 MFA，同时仍使用强随机
`ASK_CODEX_TOKEN` 作为独立的应用层门禁。

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
Codex Desktop Electron 包和私有 IPC。Ask Codex 改为面向有文档的 app-server
接口，因此集成面更小，也不需要重新分发桌面应用。

底层会话、轮次、条目和审批协议请参阅官方
[Codex app-server 文档](https://developers.openai.com/codex/app-server/)。
