# ADR 0025：移动端优先保留无地址栏启动，暂不发布 PWA Manifest

- 状态：已接受
- 决策日期：2026-08-11

## 背景

Ask Codex 的移动端目标是尽量扩大实际对话工作区，关键验收标准是从 Android 主屏幕启动后
不显示 Chrome 地址栏，而不是被 Android 登记为 WebAPK、提供离线能力或满足完整 PWA
安装条件。

在受 Cloudflare Access 保护的公开 Origin 上，Android Chrome 最初通过“添加到主屏幕”创建了
带现有机器人 favicon 的入口，启动后没有地址栏。一次实验随后加入 Web App Manifest 和正式
安装图标；同一手机重新创建入口后，结果却变为灰底账号首字母图标，并在普通 Chrome 窗口中
显示地址栏。这与 Chrome 退回“创建快捷方式”的表现一致。

实验期间，本机使用可信公开 `Host` 请求 Manifest 可以取得正确资源，但未携带 Access Cookie
的公网请求收到 Cloudflare Access 的 `302` HTML 登录跳转。该证据说明 Access 可能影响 Chrome
的安装资源获取或启动跳转，但不足以证明它是唯一原因。移除 Manifest 和安装图标后，用户在
同一真机上重新创建入口，原有机器人图标与无地址栏启动均已恢复。

## 决策

- 当前版本不发布 Web App Manifest、PWA 安装图标或 Service Worker，也不把 Ask Codex 宣称为
  可离线或保证生成 WebAPK 的 PWA。
- 保留现有 favicon，并把 Android Chrome 主屏幕入口视为浏览器提供的尽力而为启动方式。
  验收以真机启动后是否没有地址栏、可用视口是否增大为准，不以 Android 应用信息中的分类为准。
- 不得为了提高 PWA installability 绕过、弱化或拆分 Cloudflare Access 保护。
- 只有在受 Access 保护的真实公开 Origin 上完成受控真机验证后，才重新考虑 Manifest。验证必须
  覆盖删除旧入口、完成 Access 登录、首次创建、异步安装完成、冷启动和再次启动，并确认图标、
  最终 Origin、地址栏状态以及认证跳转均符合预期。
- 出现灰底账号首字母图标和地址栏时，只删除该失败入口，在 Chrome 中完成 Access 登录并重新
  打开 Ask Codex 后再创建。不要把清除站点数据作为常规排障步骤，因为它会删除同源 IndexedDB
  中有界保存的附件预览和下载副本。

## 理由

当前用户需求已经由更简单的主屏幕启动路径满足，而正式 Manifest 在唯一已验证的真机和部署
组合中直接破坏了最重要的结果。保留一个未带来实际价值、反而可能让 Cloudflare Access 登录
跳转参与安装判定的 Manifest，会制造比缺少 PWA 标签更差的移动体验。

这个选择不把一次设备现象误写成浏览器或 Cloudflare 的普遍保证。它保留以后重新验证的空间，
同时要求任何后续 PWA 工作先证明不会牺牲无地址栏启动和现有访问边界。

## 影响

- 当前 Android Chrome 真机恢复了机器人图标和无地址栏启动，满足扩大显示面积的主要目标。
- Chrome 菜单文案、创建耗时、启动模式和图标仍可能随浏览器版本、配置文件或设备变化；项目
  不承诺系统级 WebAPK 或稳定的“安装应用”入口。
- Ask Codex 不提供离线缓存；Cloudflare Access 和 Ask Codex token 仍需在各自会话失效后重新
  验证。
- 后续开发者不会仅因为“移动端像应用”就重新加入 Manifest；必须先复现并通过上述真机门槛。

## 考虑过的替代方案

- 保留 Manifest 和正式安装图标：暂时拒绝，因为已验证路径退化为账号首字母图标和带地址栏窗口。
- 对 Manifest、图标或启动 URL 绕过 Cloudflare Access：拒绝，因为安装便利性不能削弱独立的
  外层身份关卡，而且公开部分安装资源也不能保证认证后的启动链路保持 standalone。
- 加入 Service Worker 以增强 PWA 资格：拒绝，因为当前不需要离线能力，还会为认证页面、前端
  更新和敏感会话引入额外缓存状态。
- 使用 Trusted Web Activity 或原生壳：暂不采用，因为当前主屏幕入口已经满足核心目标，而原生
  打包、签名和发布会显著扩大维护范围。
