# Deploy Ask Codex with Cloudflare Tunnel

English | [简体中文](cloudflare-tunnel.md)

This guide publishes a single-user Ask Codex installation through Cloudflare
Tunnel and Cloudflare Access while keeping the Ask Codex gateway bound to
`127.0.0.1`. The tested layout is:

```text
Browser
  -> Cloudflare Access (exact user + MFA)
  -> Cloudflare edge TLS
  -> cloudflared system service
  -> http://127.0.0.1:4444
  -> Ask Codex token gate
  -> Codex CLI/app-server
```

No inbound router port or `0.0.0.0` listener is required. Cloudflare Access and
`ASK_CODEX_TOKEN` are separate gates; keep both.

> Ask Codex can read files, modify workspaces, and request permission to run
> commands as its operating-system user. `ASK_CODEX_WORKSPACE` selects the
> initial directory; it is not an access boundary. Do not publish Ask Codex
> without an exact-user Access policy, MFA, and a strong application token.

Cloudflare dashboard labels change occasionally. The paths below use the
labels present in the tested Zero Trust dashboard.

## 1. Prerequisites

You need:

- A Linux device that stays online. This guide uses Debian on ARM64.
- A domain whose DNS zone is active in your Cloudflare account.
- A Cloudflare Zero Trust account. Select the Free plan when prompted.
- A hostname reserved for Ask Codex, such as `codex.example.com`.
- Node.js 22.12 or newer, npm, Git, OpenSSL, and curl on the device.
- An OpenAI account that can use Codex.
- One unprivileged Linux user that will install, authenticate, and run both
  Codex CLI and Ask Codex.

Replace these example values before running later commands:

```bash
export ASK_CODEX_DIR="/absolute/path/to/ask-codex"
export ASK_CODEX_PUBLIC_HOST="codex.example.com"
```

Confirm the Debian package architecture:

```bash
dpkg --print-architecture
```

On an ARM64 board, the expected result is `arm64`. Do not install an AMD64
package on that device.

Useful official references:

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Cloudflare Tunnel downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Protect a self-hosted application with Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

## 2. Install and authenticate Codex CLI

Install Codex CLI with the official npm package, without `sudo`, as the same
Linux user that will run Ask Codex:

```bash
npm install --global @openai/codex
command -v codex
codex --version
```

Authenticate that user:

```bash
codex login
codex login status
```

On a headless device, use device authentication if the normal browser callback
cannot reach the device:

```bash
codex login --device-auth
```

Do not run `codex login` as root and then run Ask Codex as another user. Codex
configuration, credentials, and sessions are local to the effective user and
`CODEX_HOME` (normally `~/.codex`).

## 3. Install and build Ask Codex

For a new installation:

```bash
git clone https://github.com/zlotus/ask-codex.git "$ASK_CODEX_DIR"
cd "$ASK_CODEX_DIR"
npm install
npm run build
```

`npm start` runs the compiled files in `dist-server/` and `dist/`. Rebuild after
pulling source changes; restarting alone does not update those files.

## 4. Generate and store the Ask Codex token

Generate a dedicated random token and keep it in a user-readable file. This
avoids putting the secret itself in shell history:

```bash
export ASK_CODEX_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ask-codex/token"
install -d -m 700 "$(dirname "$ASK_CODEX_TOKEN_FILE")"
(umask 077 && openssl rand -hex 32 > "$ASK_CODEX_TOKEN_FILE")
chmod 600 "$ASK_CODEX_TOKEN_FILE"
```

Store the token in a password manager so it can be entered into the browser.
Do not send it in chat, put it in a URL, commit it, or paste it into Cloudflare.
If it appears in terminal logs, screenshots, or messages, rotate it before
publishing the service.

To display it once for entry into the password manager without putting the
secret itself in shell history:

```bash
printf 'Store this token now: '
cat "$ASK_CODEX_TOKEN_FILE"
```

Clear the terminal scrollback after storing it.

This token protects access to the Linux account behind Ask Codex. It is not the
Cloudflare Tunnel connector token and should not be reused for anything else.

## 5. Start on loopback with an exact public origin

Start Ask Codex in the foreground first. Keep this terminal open:

```bash
cd "$ASK_CODEX_DIR"

ASK_CODEX_HOST=127.0.0.1 \
ASK_CODEX_PORT=4444 \
ASK_CODEX_PUBLIC_ORIGIN="https://${ASK_CODEX_PUBLIC_HOST}" \
ASK_CODEX_TOKEN="$(tr -d '\r\n' < "$ASK_CODEX_TOKEN_FILE")" \
npm start
```

To set an initial workspace, create it first and add `ASK_CODEX_WORKSPACE` to
the startup environment:

```bash
install -d -m 700 /absolute/path/to/agent-workspace
```

```text
ASK_CODEX_WORKSPACE=/absolute/path/to/agent-workspace \
```

The workspace must be an existing absolute directory. It is an initial
directory, not a filesystem access boundary.

Expected output:

```text
Ask Codex listening at http://127.0.0.1:4444
```

This foreground command is for initial validation. Installing `cloudflared` as
a system service does not also supervise Ask Codex. For unattended operation,
run Ask Codex under your process manager and preserve the same unprivileged
user, working directory, protected token, `PATH` or absolute `CODEX_BIN`, and
all `ASK_CODEX_*` variables used during this test.

`ASK_CODEX_PUBLIC_ORIGIN` must be exactly one `http://` or `https://` origin.
Do not add a path, query string, fragment, username, or password. Configuring
it also makes `ASK_CODEX_TOKEN` mandatory.

In a second SSH terminal, simulate the Host and Origin headers that the tunnel
will forward:

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:4444/ \
  -H 'Host: codex.example.com' \
  -H 'Origin: https://codex.example.com'
```

Expected result:

```text
HTTP 200
```

Also confirm that a different origin is rejected:

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:4444/ \
  -H 'Host: codex.example.com' \
  -H 'Origin: https://wrong.example.com'
```

Expected result: `HTTP 403`.

Do not continue to the public route until the correct probe returns 200.

## 6. Create the Cloudflare Tunnel connector

1. Open the Cloudflare Zero Trust dashboard.
2. Go to **Networking > Tunnels**. In some dashboard versions this is
   **Networks > Connectors > Cloudflare Tunnels**.
3. Select **Create a tunnel**, choose **Cloudflared**, name it something like
   `ask-codex-device`, and save it.
4. On **Install and run a connector**, choose **Debian** and **ARM64**.
5. Run the command under **Install cloudflared** on the device.
6. Before pasting **Install as a service**, enter a temporary root shell that
   does not persist command history:

   ```bash
   sudo -H env HISTFILE=/dev/null bash --noprofile --norc
   ```

7. The dashboard command normally starts with `sudo cloudflared service
   install ...`. Inside this root shell, remove only the leading `sudo` and run
   the rest of that command exactly as shown. Then run `exit`. This registers
   `cloudflared` with systemd so the connector starts after reboot.

The service-install command contains a Tunnel connector token. Treat the
entire command as a secret: run it only on the target device and do not paste
it into your normal shell history, chat, tickets, logs, or this repository.
Entering the root shell first also avoids passing the secret as an argument to
`sudo`, whose audit log can record the complete command. The installed service
retains the token in its root-managed configuration by design. Do not copy or
publish unredacted service definitions, process listings, or diagnostic
output. If the token is exposed, rotate it or replace the connector in the
Cloudflare dashboard.

Verify locally:

```bash
cloudflared --version
sudo systemctl is-active cloudflared
```

The expected service state is `active`. Avoid using unredacted `systemctl
status`, `systemctl cat`, or process-list output as routine proof because it
can include the connector token in command arguments.

Wait until the Tunnel's **Connection status** turns green. Do not add the
published application route yet; configure Access first.

## 7. Create an exact-user Access application

1. Go to **Access controls > Applications**.
2. Select **Add an application > Self-hosted and private > Continue with
   Self-hosted and private**.
3. Under **Application details**, set:
   - Application name: `Ask Codex`
   - Session duration: `24 hours`
   - Destination type: **Public hostname**
   - Subdomain: `codex`
   - Domain: your Cloudflare zone, represented here by `example.com`
   - Path: leave blank
4. Confirm the resulting hostname is exactly `codex.example.com` (or the value
   chosen for `ASK_CODEX_PUBLIC_HOST`).

Under **Access policies**, add one policy:

- Policy name: `Only me`
- Action: **Allow**
- Include selector: **Emails**
- Value: your one exact login email address

Do not use **Everyone**, **Bypass**, **Service Auth**, an email domain, or a
wildcard. Access is default-deny; the exact-email rule should be the only rule
that grants interactive access.

Under **Authentication > Identity**:

1. Turn off **Accept all available identity providers**.
2. Select only the identity provider that you use (the tested setup selected
   the single provider named `cloudflare`).
3. Enable **Apply instant authentication** when there is only one provider.

Create/save the application.

## 8. Enable MFA methods

Open **Access controls > Access settings > MFA methods** and enable methods you
can actually use:

- Enable **Authenticator application**. This is the recommended portable
  recovery method for this setup.
- Enable **Biometrics** if your phone or computer supports it.
- Enable **Security key** only if you own and have enrolled a hardware key.
- Leave **Personal Identity Verification (PIV) key** off unless you operate an
  enterprise PIV environment.

Save the global method list. Enabling methods makes them available; the next
step makes MFA mandatory for Ask Codex.

Edit the `Ask Codex` Access application and open **Authentication > MFA**:

1. Select **Customize MFA settings**.
2. Select **Authenticator application** and, if desired, **Biometrics**.
3. Do not require a hardware security key unless you have one.
4. Keep **Authentication duration** at `24 hours` or choose a shorter period.
5. Save the application.

Do not select **Respect global enforcement setting** when the page reports
`Global enforcement: Off`; that would not enforce MFA for this application.
Do not select **Disable MFA** for Ask Codex.

## 9. Bootstrap MFA enrollment through App Launcher

On a new Access account, choosing **Set up MFA now** may show:

```text
Please contact your administrator to enable the Access App Launcher
application for your organization.
```

The App Launcher needs its own exact-user policy before it can host MFA
enrollment.

1. Go to **Access controls > Applications > Additional settings > App Launcher
   customization > Manage app launcher settings**. The destination page may be
   labeled **Access controls > Access settings > Manage your App Launcher**.
2. Under **App launcher policies**, create an Allow policy named
   `Only me launcher` with **Include > Emails** set to the same exact email.
3. Under **Authentication > Identity**, turn off **Accept all available identity
   providers**, select only your chosen provider, and enable instant
   authentication when only one provider is available.
4. Under **Authentication > MFA**, temporarily select **Disable MFA** for the
   App Launcher and save.

This temporary exception breaks the enrollment loop. It applies only to the
exact-email App Launcher policy; MFA remains required on the Ask Codex
application.

After the public route exists, sign in through `https://codex.example.com`,
choose **Set up MFA now**, and register **Authenticator application**. Store
any recovery codes in a password manager. Never share the QR code, manual
secret, verification code, or recovery codes.

Immediately after enrollment, return to **Manage your App Launcher >
Authentication > MFA**, change it from **Disable MFA** to **Customize MFA
settings**, select the enrolled method(s), and save. This closes the bootstrap
exception.

Official references:

- [Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)
- [Access App Launcher](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/)

## 10. Publish the loopback application

Return to the Tunnel:

1. Go to **Networking > Tunnels > ask-codex-device**.
2. Select **Add route > Published application**.
3. Fill the form as follows:
   - Subdomain: `codex`
   - Domain: `example.com`
   - Full hostname: `codex.example.com`
   - Path: leave blank
   - Service URL: `http://127.0.0.1:4444`
4. Save **Add published application**.

Cloudflare creates the DNS record automatically. The origin service is plain
HTTP because traffic from `cloudflared` to Ask Codex stays on loopback; public
TLS terminates at Cloudflare.

Preserve the original public `Host` header. Do not configure an origin override
such as:

```yaml
httpHostHeader: localhost
```

and do not set it to `127.0.0.1`. Ask Codex checks both `Host` and `Origin`
against `ASK_CODEX_PUBLIC_ORIGIN`; a Host override will cause HTTP 403 and
WebSocket failures.

The equivalent ingress shape is:

```yaml
ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:4444
  - service: http_status:404
```

## 11. Validate Access and the browser flow

Before authenticating in a browser, verify that Cloudflare Access intercepts
an anonymous request:

```bash
curl -sS -D - -o /dev/null https://codex.example.com/
```

Expected result: `HTTP 302`. The redirect should target your account's
`cloudflareaccess.com` login hostname. An anonymous `HTTP 200` means the Access
application is not protecting the same hostname; stop and fix it before using
Ask Codex.

The `Location` header can contain signed, short-lived login state. When asking
for help, share only the status line and whether the hostname ends in
`cloudflareaccess.com`; do not publish the full URL or any `Set-Cookie` header.

Then use a private/incognito browser window:

1. Open `https://codex.example.com`.
2. Sign in through the one configured identity provider using the exact email
   allowed by the policy.
3. On first use, enroll and complete the configured MFA method. If enrollment
   has already been completed, satisfy the MFA challenge.
4. Confirm that the Ask Codex page appears only after Access authentication.
5. Enter the separate Ask Codex token from your password manager.
6. Start a test conversation and verify streaming and approval prompts.
7. Re-enable App Launcher MFA as described in the previous section if it is
   still temporarily disabled.

Do not weaken or remove `ASK_CODEX_TOKEN` after Access works. Access protects
the Cloudflare route; the application token remains useful if Access or route
configuration is changed accidentally.

### Address-bar-free Android home-screen launch

The repository intentionally does not provide a Web App Manifest, PWA
installation icons, or a Service Worker. On the tested physical-device path
protected by Cloudflare Access, adding those resources regressed to a gray
account-initial icon and a window with the address bar. Removing them restored
the robot icon and address-bar-free launch. Access may have affected Chrome's
installation-resource fetch or authentication transition, but the evidence does
not establish it as the only cause. See
[ADR 0025](decisions/0025-prioritize-chrome-less-mobile-launch-over-pwa-installation.en.md)
for the complete decision and revalidation gate.

To maximize the mobile viewport:

1. Complete Cloudflare Access authentication in Chrome and open a working Ask
   Codex page.
2. Use Chrome's Add to Home screen action. Labels and completion time vary by
   version; after submitting it once, wait briefly and check the launcher before
   creating a duplicate.
3. Launch from the new icon. Treat the absence of the address bar and the larger
   usable viewport as success; Android App info does not need to identify it as
   a Web App or WebAPK.

If Chrome creates a gray account-initial icon that still opens with the address
bar, delete only that failed entry, return to the Access-authenticated page in
Chrome, and create it again. Do not clear Ask Codex site data as routine
troubleshooting because that removes attachment previews and download copies
stored in same-Origin IndexedDB. Do not bypass or weaken Access to improve the
installation result.

## Troubleshooting

### Local Host/Origin probe returns 403

First confirm the running process received the expected variables without
printing the secret:

```bash
PID="$(pgrep -n -f '[n]ode dist-server/index.js')"

tr '\0' '\n' < "/proc/$PID/environ" |
  sed -n \
    -e '/^ASK_CODEX_HOST=/p' \
    -e '/^ASK_CODEX_PORT=/p' \
    -e '/^ASK_CODEX_PUBLIC_ORIGIN=/p' \
    -e 's/^ASK_CODEX_TOKEN=.*/ASK_CODEX_TOKEN=<set>/p'
```

Check whether the running build contains public-origin support:

```bash
APP_DIR="$(readlink -f "/proc/$PID/cwd")"

grep -n 'ASK_CODEX_PUBLIC_ORIGIN' \
  "$APP_DIR/dist-server/server.js" \
  "$APP_DIR/dist-server/security.js"
```

No matches usually means the source was pulled but the production artifacts
are stale. Stop Ask Codex, then run:

```bash
cd "$APP_DIR"
git pull --ff-only
npm install
npm run build
```

Restart with the exact origin and repeat the local probe. Also check for a
hostname typo, a path in `ASK_CODEX_PUBLIC_ORIGIN`, an unexpected port, or a
Cloudflare `httpHostHeader` override.

### `spawn codex ENOENT`

Ask Codex cannot find the `codex` executable in its process `PATH`:

```bash
command -v codex || echo 'codex not found'
```

Install Codex CLI as the Ask Codex user:

```bash
npm install --global @openai/codex
command -v codex
codex login status
```

Restart Ask Codex if necessary. If a service manager has a restricted `PATH`,
set `CODEX_BIN` to the absolute result from `command -v codex` in that service's
environment. Do not point it at an executable owned by an untrusted user.

### Cloudflare returns 502

A 502 normally means `cloudflared` cannot reach the configured origin. On the
device, check:

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:4444/ \
  -H 'Host: codex.example.com' \
  -H 'Origin: https://codex.example.com'

sudo systemctl is-active cloudflared
sudo journalctl -u cloudflared -n 100 --no-pager
```

Inspect logs locally and redact any token or command line before sharing the
output.

Confirm Ask Codex is still running, the published route uses
`http://127.0.0.1:4444` (not HTTPS), and the Tunnel connector is green.

### Access login works but MFA enrollment is blocked

Confirm all of the following:

- The App Launcher has an Allow policy for the same exact email.
- The desired method is enabled under global **MFA methods**.
- App Launcher MFA is temporarily disabled only during initial enrollment.
- The Ask Codex application uses **Customize MFA settings** and includes the
  method being enrolled.

After enrollment, require MFA on the App Launcher again.

### The UI loads but WebSocket connection fails

Repeat the local Host/Origin probe, confirm the public hostname exactly matches
`ASK_CODEX_PUBLIC_ORIGIN`, and remove any `httpHostHeader` override. Also check
that the browser reached the HTTPS hostname rather than the loopback URL.

### Thread history is empty

Codex history is local to the machine, operating-system user, and `CODEX_HOME`.
A newly installed device is expected to have an empty list even if another
computer has Codex history.

Check the official CLI view without opening a thread:

```bash
codex resume --all
```

Exit the selector with `Esc` or `Ctrl+C`. Session transcripts normally live in
`$CODEX_HOME/sessions` (default `~/.codex/sessions`), with archived sessions in
`$CODEX_HOME/archived_sessions`. Ensure Ask Codex and the CLI run as the same
Linux user with the same `CODEX_HOME`. `ASK_CODEX_WORKSPACE` does not select or
transfer session history.

## Updating

For an Ask Codex update, stop the foreground server, then run:

```bash
cd "$ASK_CODEX_DIR"
git status --short
git pull --ff-only
npm install
npm run build
```

Review unexpected local changes before pulling. Restart Ask Codex with the same
loopback host, port, public origin, workspace, and token file. Repeat the local
Host/Origin 200 test and the anonymous public 302 test after every update.

If Ask Codex is managed by systemd or another supervisor, remember that the
`cloudflared` service is separate. Configure and monitor both services.

Update Codex CLI separately:

```bash
npm install --global @openai/codex@latest
codex --version
```

Update `cloudflared` through the same official Debian package channel used for
installation, then confirm its systemd service and Tunnel connection are
healthy. Follow Cloudflare's
[update instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/)
for the installed package type.

To rotate the Ask Codex token, stop Ask Codex, overwrite the protected token
file, and restart. Existing browsers must enter the new value:

```bash
(umask 077 && openssl rand -hex 32 > "$ASK_CODEX_TOKEN_FILE")
chmod 600 "$ASK_CODEX_TOKEN_FILE"
```

## Security checklist

- Ask Codex listens only on `127.0.0.1`; no router port is forwarded.
- `ASK_CODEX_PUBLIC_ORIGIN` is one exact HTTPS origin with no path.
- The Tunnel route uses `http://127.0.0.1:4444` and a blank path.
- The proxy preserves the public Host; no `httpHostHeader` override exists.
- Cloudflare Access is default-deny and allows one exact email only.
- Only the intended identity provider is enabled for the application.
- MFA is required for Ask Codex and, after enrollment, for App Launcher.
- `ASK_CODEX_TOKEN` is strong, unique, stored privately, and never placed in a
  URL, repository, screenshot, message, or Cloudflare configuration.
- The Cloudflare connector token is also treated as a secret.
- Codex CLI and Ask Codex run as the same unprivileged Linux user.
- Codex sandboxing remains enabled and every approval is reviewed carefully.
- You remember that `ASK_CODEX_WORKSPACE` is an initial directory, not a
  filesystem sandbox.
- Ask Codex, Codex CLI, `cloudflared`, Node.js, and the host OS receive regular
  security updates.
- SSH access to the device is restricted and protected with strong
  authentication.
