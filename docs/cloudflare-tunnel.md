# 通过 Cloudflare Tunnel 私有部署 Ask Codex

[English](cloudflare-tunnel.en.md) | 简体中文

本文介绍如何在一台长期在线的 Debian ARM64 设备上运行 Ask Codex，并通过
Cloudflare Tunnel 使用自己的 HTTPS 域名访问。示例域名统一使用
`codex.example.com`，请替换成你自己的域名。

最终链路如下：

```text
浏览器
  -> Cloudflare Access（指定账号 + MFA）
  -> Cloudflare Tunnel（不开放家庭路由器端口）
  -> http://127.0.0.1:4444（Ask Codex token）
  -> codex app-server（本机 Codex 登录、会话和工作区）
```

这套配置有两道独立门禁：Cloudflare Access 验证身份，Ask Codex 再验证
`ASK_CODEX_TOKEN`。不要因为启用了其中一道而省略另一道。

## 1. 准备工作

开始前确认：

- 域名已由当前 Cloudflare 账号管理；本文使用 `example.com`。
- 设备可以长期联网，系统为 Debian 或兼容发行版。
- 已安装 Node.js 22.12 或更高版本，以及 npm 和 Git。
- 计划使用的公网主机名尚未被其他服务占用；本文使用
  `codex.example.com`。
- 你有一个只属于自己的邮箱地址，可用于 Cloudflare Access 的精确匹配策略。
- 不需要在家庭路由器上做端口转发，也不需要让 Ask Codex 监听 `0.0.0.0`。

检查基础环境和 CPU 架构：

```bash
node --version
npm --version
git --version
dpkg --print-architecture
```

Rockchip 等 ARM64 设备的最后一条通常输出：

```text
arm64
```

Cloudflare Tunnel 和 Access 均有适合个人使用的免费方案。如果控制台要求选择
Zero Trust 方案，选择当时页面显示的 Free 方案，并以 Cloudflare 当前的额度与
条款为准。

## 2. 安装并登录 Codex CLI

Ask Codex 不内置 Codex。它会在服务器上启动当前 Unix 用户可用的
`codex app-server`，因此必须用将来运行 Ask Codex 的同一个 Unix 用户安装并登录
Codex CLI：

```bash
npm install --global @openai/codex
command -v codex
codex --version
codex login
codex login status
```

无桌面环境且常规浏览器回调无法返回设备时，可以改用：

```bash
codex login --device-auth
```

`command -v codex` 必须输出一个可执行文件路径。登录信息和历史会话通常保存在该
用户的 `~/.codex` 下；换设备、换 Unix 用户或设置不同的 `CODEX_HOME`，看到的会话
列表也会不同。

Codex CLI 的安装和登录方式可能随版本变化，可同时参考 OpenAI 官方的
[Codex CLI 文档](https://developers.openai.com/codex/cli/)和
[Codex app-server 文档](https://developers.openai.com/codex/app-server/)。

## 3. 下载并构建 Ask Codex

首次安装：

```bash
git clone https://github.com/zlotus/ask-codex.git
cd ask-codex
npm install
npm run build
```

构建成功时，Vite 会在末尾报告 `built`，并生成 `dist/` 和
`dist-server/`。生产启动命令读取这些构建产物；只拉取源码而不重新构建，可能仍在
运行旧逻辑。

## 4. 生成并妥善保存 Ask Codex token

使用 OpenSSL 生成 32 字节随机值，并保存到只有当前用户可读的专用文件。下面的命令
不会把密钥字面量写入 shell 历史：

```bash
export ASK_CODEX_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ask-codex/token"
install -d -m 700 "$(dirname "$ASK_CODEX_TOKEN_FILE")"
(umask 077 && openssl rand -hex 32 > "$ASK_CODEX_TOKEN_FILE")
chmod 600 "$ASK_CODEX_TOKEN_FILE"
```

只显示一次并立即存入密码管理器：

```bash
printf '请立即保存这个 token：'
cat "$ASK_CODEX_TOKEN_FILE"
```

显示后清理终端滚屏。不要把它发到聊天、工单、截图、Git、Cloudflare 配置或命令行
参数里。尤其不要直接执行这种命令：

```text
ASK_CODEX_TOKEN='真实密钥' npm start
```

因为真实密钥会进入 shell 历史。token 文件必须保持 `0600`，不要放进仓库的
`.env`。长期运行时可以让进程管理器从这个受保护文件生成自己的凭据或环境配置，
但不要让文件变成其他用户可读。

如果 token 曾出现在聊天、截图或日志中，应立即生成新 token 并重启 Ask Codex。
重启后旧 token 自动失效。

## 5. 仅在回环地址启动 Ask Codex

先不要配置公网路由。在 Ask Codex 目录中启动生产服务：

```bash
ASK_CODEX_HOST=127.0.0.1 \
ASK_CODEX_PORT=4444 \
ASK_CODEX_PUBLIC_ORIGIN=https://codex.example.com \
ASK_CODEX_TOKEN="$(tr -d '\r\n' < "$ASK_CODEX_TOKEN_FILE")" \
npm start
```

如需固定初始工作目录，可再加一行：

```text
ASK_CODEX_WORKSPACE=/home/your-user/agentws \
```

目录必须事先存在，并且必须是绝对路径。它只是初始目录，不是安全边界；通过认证的
用户仍可能选择其他绝对路径，并可批准 Codex 请求更高权限。

预期输出：

```text
Ask Codex listening at http://127.0.0.1:4444
```

这条前台命令用于首次验证。把 `cloudflared` 注册为 systemd 服务并不会同时托管
Ask Codex。需要无人值守运行时，应另用进程管理器维护 Ask Codex，并保持与手工测试
相同的非特权 Unix 用户、工作目录、受保护 token、`PATH` 或绝对 `CODEX_BIN`，以及
全部 `ASK_CODEX_*` 变量。

`ASK_CODEX_PUBLIC_ORIGIN` 必须是一个完整且唯一的 `http://` 或 `https://`
Origin，不能包含路径、查询参数、片段、用户名或密码。公开访问应使用 `https://`。
配置该变量后，Ask Codex 会强制要求同时设置 `ASK_CODEX_TOKEN`。

### 本机验证 Host 和 Origin

保持服务运行，另开一个 SSH 终端执行：

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:4444/ \
  -H 'Host: codex.example.com' \
  -H 'Origin: https://codex.example.com'
```

预期结果：

```text
HTTP 200
```

这一步在创建公网 DNS 之前就验证了 Ask Codex 是否接受 Tunnel 将来转发的公开
`Host` 和浏览器 `Origin`。

## 6. 创建 Cloudflare Tunnel

Cloudflare 控制台的栏目名称会随版本调整。当前常见路径是：

```text
Zero Trust -> Networks（或 Networking）-> Tunnels
```

部分页面会显示为：

```text
Networks -> Connectors -> Cloudflare Tunnels
```

操作步骤：

1. 点击 `Create a tunnel`。
2. 连接器类型选择 `Cloudflared`。
3. Tunnel 名称填写 `ask-codex-device`，保存。
4. 停在 `Install and run a connector` 页面。
5. 操作系统选择 `Debian`，架构选择 `ARM64` 或 `64-bit ARM`。
6. 先执行页面 `Install cloudflared` 下的命令。
7. 在粘贴 `Install as a service` 命令之前，进入一个不持久保存历史的临时 root
   shell：

   ```bash
   sudo -H env HISTFILE=/dev/null bash --noprofile --norc
   ```

8. 控制台命令通常以 `sudo cloudflared service install ...` 开头。在这个 root shell
   中只去掉开头的 `sudo`，其余部分原样执行，完成后运行 `exit`。Tunnel 将由
   systemd 自动启动。

Cloudflare 生成的服务安装命令包含 Tunnel connector token。它与密码等价：只从
控制台直接复制到目标设备，不要发给其他人，也不要放入普通 shell 历史、文档、截图
或工单。先进入 root shell 还可以避免把密钥作为参数交给 `sudo`，因为 sudo 审计日志
可能记录完整命令。安装后的 systemd 服务会按设计在 root 管理的配置中保留该 token；
不要复制或公开未经脱敏的服务定义、进程列表或诊断输出。如果 connector token 已
泄露，应在 Cloudflare 控制台轮换或重建连接器。

安装后可检查：

```bash
cloudflared --version
sudo systemctl is-active cloudflared
```

预期服务状态为 `active`。日常验证不要使用未经脱敏的 `systemctl status`、
`systemctl cat` 或进程列表，因为它们可能在命令参数中显示 connector token。

回到 Tunnel 页面，等待 `Connection status` 变绿。此时只有设备到 Cloudflare 的
出站连接，Ask Codex 还没有公开路由。

Cloudflare 官方参考：

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [创建远程管理的 Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)

## 7. 先创建 Cloudflare Access 应用

先配置 Access，再添加 Tunnel 的公网路由，可以避免域名出现一段没有身份门禁的
时间。

进入：

```text
Access controls -> Applications -> Add an application
  -> Self-hosted and private -> Continue with Self-hosted and private
```

### Application details / Destinations

填写：

| 字段 | 值 |
| --- | --- |
| Application name | `Ask Codex` |
| Session duration | `24 hours` |
| Destination type | `Public hostname` |
| Subdomain | `codex` |
| Domain | `example.com` |
| Path | 留空 |

最终主机名应为 `codex.example.com`。不要填写通配符，也不要开启与本项目无关的
browser-based RDP、SSH 或 VNC。

### Access policies

新增一条策略：

| 字段 | 值 |
| --- | --- |
| Policy name | `Only me` |
| Action | `Allow` |
| Include selector | `Emails` |
| Value | 你自己的完整邮箱地址 |

不要使用 `Everyone`、`Bypass` 或 `Service Auth`。Access 策略默认拒绝未匹配
身份；这里用精确邮箱只放行本人。

### Authentication / Identity

在应用的 `Authentication` -> `Identity` 中：

1. 关闭 `Accept all available identity providers`。
2. 在 `Choose available identity providers for this application` 中只选择你实际使用的
   单一身份提供商；在仅有默认提供商的账号中，它可能显示为 `Cloudflare`。
3. 只有一个登录方式时，开启 `Instant Auth` 或 `Apply instant authentication`。

这样将来即使账号新增其他身份提供商，也不会自动扩大该应用的登录入口。

Cloudflare 官方参考：
[保护 Self-hosted 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

## 8. 启用并强制 MFA

Cloudflare 将“允许哪些 MFA 注册方式”和“某个应用是否强制 MFA”分开配置。只打开
MFA methods 并不等于已经强制应用使用 MFA。

### 8.1 允许 MFA 注册方式

另开一个控制台标签页，进入：

```text
Access controls -> Access settings -> MFA methods
```

个人设备推荐：

| 方法 | 建议 |
| --- | --- |
| Biometrics | 开启，可使用系统支持的平台验证器 |
| Authenticator application | 开启，作为跨设备备用方式 |
| Security key | 仅持有实体安全密钥时开启 |
| PIV key | 一般保持关闭 |

保存后回到 `Ask Codex` 应用并刷新。

### 8.2 为 Ask Codex 单独强制 MFA

在 `Ask Codex` 应用的 `Authentication` -> `MFA` 中：

1. 选择 `Customize MFA settings`。
2. 选择 `Biometrics` 和 `Authenticator application`。
3. 只有确实持有实体安全密钥时才选择 `Security key`。
4. `Authentication duration` 可设置为 `24 hours`。
5. 保存或创建应用。

如果页面显示 `Global enforcement: Off`，不要选择
`Respect global enforcement setting`，否则该应用不会实际要求 MFA。也不要选择
`Disable MFA`。

### 8.3 首次注册 MFA：配置 App Launcher

首次登录时，可能先看到：

```text
No authentication methods set up. Set up MFA now
```

点击后又出现：

```text
Please contact your administrator to enable the Access App Launcher
```

这是首次注册流程依赖 App Launcher，而 App Launcher 尚无放行策略造成的。按下面
步骤完成一次引导：

1. 进入 `Access controls` -> `Applications` -> `Additional settings`。
2. 在 `App Launcher customization` 中点击 `Manage app launcher settings`。
3. 新增 `Only me launcher` 策略：`Allow` + `Emails` + 同一个完整邮箱地址。
4. 在 App Launcher 的 `Authentication` -> `Identity` 中关闭接受全部身份提供商，
   只选择同一个提供商；只有一个登录方式时开启即时认证。
5. 在 App Launcher 的 `Authentication` -> `MFA` 中临时选择 `Disable MFA` 并保存。
6. 重新访问 `https://codex.example.com`，登录后点击 `Set up MFA now`。
7. 选择 `Authenticator application`，扫描二维码并输入验证码完成注册；妥善保存页面
   给出的恢复信息。二维码、种子密钥、验证码和恢复码都不能分享。
8. 注册完成后，立即回到 App Launcher 设置，把 `Disable MFA` 改为
   `Customize MFA settings`，选择已注册的方法并保存。如果你已经启用了全局 MFA
   强制，也可以改用 `Respect global enforcement setting`。

第 5 步只是为打破“进入 Launcher 前必须已有 MFA、注册 MFA 又必须先进入
Launcher”的首次引导循环，不应长期保持禁用。`Ask Codex` 应用自身在整个过程中
仍使用第 8.2 节配置的应用级 MFA。

Cloudflare 官方参考：

- [Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)
- [Access App Launcher](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/)

## 9. 添加 Published application 路由

回到：

```text
Networks（或 Networking）-> Tunnels -> ask-codex-device
  -> Add route -> Published application
```

填写：

| 字段 | 值 |
| --- | --- |
| Subdomain | `codex` |
| Domain | `example.com` |
| Path | 留空 |
| Service URL | `http://127.0.0.1:4444` |

确认完整主机名是 `codex.example.com` 后创建路由。Cloudflare 会自动配置对应 DNS。

不要设置 `httpHostHeader: localhost`、`httpHostHeader: 127.0.0.1` 或其他 Host
覆盖。Ask Codex 会同时校验：

- 请求 `Host` 是否精确匹配 `ASK_CODEX_PUBLIC_ORIGIN` 的主机名和有效端口；
- 浏览器提供 `Origin` 时，是否精确匹配 `ASK_CODEX_PUBLIC_ORIGIN`。

Tunnel 必须保留原始公开 `Host: codex.example.com`。本机上游使用 HTTP 是正常的：
浏览器到 Cloudflare 使用 HTTPS，Cloudflare Tunnel 再通过设备本机回环地址访问
Ask Codex。

## 10. 验证公网门禁和浏览器访问

先在任意未携带 Access Cookie 的终端检查：

```bash
curl -sS -D - -o /dev/null https://codex.example.com/
```

预期响应以 `HTTP/2 302` 或等价的 3xx 开头，并且 `location` 指向你的
Cloudflare Access 登录域名。这证明未认证请求先被 Access 拦截，而不是直接到达
Ask Codex。

`location` 中可能包含一次性签名状态。排障时只分享 HTTP 状态行，不要公开整条登录
URL、`set-cookie` 或其他认证响应头。

然后使用无痕或隐私浏览器访问：

```text
https://codex.example.com
```

完整成功路径应为：

1. Cloudflare 身份登录。
2. 已注册的 MFA 验证；首次使用时先完成注册。
3. 进入 Ask Codex 的 token 输入界面。
4. 输入保存在密码管理器中的 `ASK_CODEX_TOKEN`。
5. Ask Codex 成功连接本机 `codex app-server`，可新建或恢复会话。

不要用能否看到登录页作为最终验证；至少再创建一个测试会话，确认 WebSocket、Codex
启动和审批交互都正常。

## 11. 常见故障

### 本机 Host/Origin 检查返回 HTTP 403

常见原因：运行中的进程没有收到新环境变量，或者只拉取了源码却没有重新构建。

先确认进程环境，不要打印真实 token：

```bash
PID="$(pgrep -n -f '[n]ode dist-server/index.js')"

tr '\0' '\n' <"/proc/$PID/environ" |
  sed -n \
    -e '/^ASK_CODEX_HOST=/p' \
    -e '/^ASK_CODEX_PORT=/p' \
    -e '/^ASK_CODEX_PUBLIC_ORIGIN=/p' \
    -e 's/^ASK_CODEX_TOKEN=.*/ASK_CODEX_TOKEN=<set>/p'
```

四项都正确时，再检查运行目录和构建产物：

```bash
APP_DIR="$(readlink -f "/proc/$PID/cwd")"
printf '运行目录：%s\n' "$APP_DIR"
grep -n 'ASK_CODEX_PUBLIC_ORIGIN' \
  "$APP_DIR/dist-server/server.js" \
  "$APP_DIR/dist-server/security.js"
```

如果构建产物不包含该变量，停止服务后在正确目录执行：

```bash
git pull --ff-only
npm install
npm run build
```

然后带完整环境变量重新启动。其他 403 原因包括：公网域名拼写不一致、
`ASK_CODEX_PUBLIC_ORIGIN` 带路径、Tunnel 覆盖了 Host，或配置中的端口与请求有效端口
不一致。

### 输入 token 后显示 `spawn codex ENOENT`

这表示 Ask Codex 启动子进程时在其 `PATH` 中找不到 `codex`：

```bash
command -v codex || echo 'codex not found'
```

未安装时，用运行 Ask Codex 的同一个 Unix 用户执行：

```bash
npm install --global @openai/codex
codex login
```

如果交互式终端能找到，而 systemd 或其他进程管理器找不到，将绝对路径显式配置为
`CODEX_BIN`，例如在启动环境中设置：

```text
CODEX_BIN=/absolute/path/from-command-v-codex
```

修改启动环境后重启 Ask Codex。

### Cloudflare 返回 502

502 通常表示 Tunnel 已收到请求，但 `cloudflared` 无法连接本机上游。依次检查：

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:4444/
sudo systemctl is-active cloudflared
```

如需查看 `journalctl -u cloudflared` 等诊断日志，只在本机检查；分享前必须先删除
token 和完整命令行。

同时确认：

- Ask Codex 进程仍在运行且监听 `127.0.0.1:4444`。
- Published application 的 Service URL 是 `http://127.0.0.1:4444`。
- `cloudflared` 与 Ask Codex 在同一台设备；若不在同一网络命名空间，
  `127.0.0.1` 指向的对象会不同。
- 本机上游没有误写成 `https://127.0.0.1:4444`。

### 公网请求直接进入 Ask Codex，没有出现 Access 登录

立即删除或禁用 Published application 路由，再检查：

- Access 应用的 Destination 是否精确为 `codex.example.com`，Path 是否留空。
- Access 策略是否为 `Allow` + 精确邮箱。
- Tunnel 路由和 Access 应用是否属于同一个 Cloudflare 账号与 zone。

修正后先用无 Cookie 的 `curl` 验证 302，再恢复浏览器测试。

### 登录后提示没有 MFA 方法，或要求管理员启用 App Launcher

确认全局 `MFA methods` 已允许 `Authenticator application` 或其他准备注册的方法，
然后按第 8.3 节配置 App Launcher 的精确邮箱策略并完成首次注册。注册后记得恢复 App
Launcher 的 MFA 要求。

### Thread 列表为空

Ask Codex 展示的是运行 Codex 进程的那个 Unix 用户、本机 `CODEX_HOME` 下的会话。
它不会从另一台机器自动同步 `~/.codex`。在同一运行用户下执行：

```bash
codex resume --all
```

如果官方 CLI 的列表也为空，通常说明这是新设备、新用户或新的 `CODEX_HOME`，不是
Ask Codex 删除了历史。如果 CLI 有记录而网页没有，再记录 Codex CLI 版本和 Ask
Codex 版本进行排查，不要移动或删除 `~/.codex/sessions`。

### Tunnel 为绿色，但域名无法访问

确认 Published application 路由已经创建、DNS 由 Cloudflare 自动生成、Hostname
拼写正确且 Path 留空。DNS 和边缘配置刚保存时也可能需要短暂时间传播。

## 12. 更新、重启与 token 轮换

升级 Ask Codex 时先停止当前进程，然后执行：

```bash
cd /home/your-user/ask-codex
git pull --ff-only
npm install
npm run build
```

再使用原有的 Host、端口、Public Origin、工作目录和 token 启动。生产进程运行的是
`dist-server/` 和 `dist/`，因此每次更新源码后都要重新构建并重启。

升级 Codex CLI：

```bash
npm install --global @openai/codex
codex --version
```

升级后应冒烟测试：新建会话、恢复会话、命令审批和文件变更审批。

轮换 Ask Codex token 时：

1. 用第 4 节命令生成新值并存入密码管理器。
2. 更新受保护的运行配置。
3. 重启 Ask Codex。
4. 在浏览器中使用新 token；确认旧 token 已无法连接。

`cloudflared` 作为 systemd 服务安装后会随系统启动。Ask Codex 本身也需要由可靠的
进程管理器维持运行；无论使用 systemd 还是其他方式，都要确保运行用户、工作目录、
`PATH`/`CODEX_BIN` 和受保护的环境变量与手工验证时一致。

## 13. 上线前安全检查

- Ask Codex 只监听 `127.0.0.1`，没有监听 `0.0.0.0`。
- 家庭路由器没有为 `4444` 或 Ask Codex 开放端口转发。
- `ASK_CODEX_PUBLIC_ORIGIN` 精确为 `https://codex.example.com`，不含路径。
- 使用至少 32 字节随机 `ASK_CODEX_TOKEN`，且未出现在历史、Git、聊天或日志中。
- Cloudflare Access 只允许一个精确邮箱，没有 `Everyone`、`Bypass` 或无关的
  `Service Auth` 策略。
- Ask Codex 应用强制 MFA；App Launcher 首次注册完成后也已恢复 MFA。
- Tunnel 路由 Path 留空，上游是 `http://127.0.0.1:4444`。
- Tunnel 没有设置 `httpHostHeader`，公开 Host 得到保留。
- 无 Cookie 的公网 `curl` 返回 Access 302，而不是 Ask Codex 页面。
- 浏览器还必须输入独立的 Ask Codex token 才能建立会话。
- Codex 与 Ask Codex 由专用或受控 Unix 用户运行；已理解
  `ASK_CODEX_WORKSPACE` 不是文件访问边界。
- 系统、Node.js、Codex CLI、Ask Codex 和 `cloudflared` 有定期更新计划。
- 每次命令、文件修改和提权审批都核对工作目录与权限范围。
