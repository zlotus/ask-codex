# ADR 0003: Use independent Cloudflare Access and application-token gates

- Status: Accepted
- Decision date: 2026-07-21
- Recorded retrospectively: 2026-07-23

## Context

The project is used from other devices, including mobile browsers, while the
Codex process runs on an always-on host. Publishing the gateway directly would
expose a service that can read files, modify workspaces, run sandboxed commands,
and request broader permissions as its operating-system user.

Cloudflare Tunnel can keep the service on loopback and Cloudflare Access can
enforce identity and MFA. An edge identity policy and an application credential
protect different boundaries, so neither should silently replace the other.

## Decision

For Cloudflare-hostname deployments:

- Keep Ask Codex bound to `127.0.0.1` and route the tunnel to that loopback
  service; do not open an inbound router port or bind publicly.
- Require an exact-user Cloudflare Access policy with MFA.
- Require a strong independent `ASK_CODEX_TOKEN` whenever
  `ASK_CODEX_PUBLIC_ORIGIN` is configured.
- Authenticate WebSocket clients in the first message frame. Never place the
  token in a URL or forward it to Codex, MCP servers, hooks, or commands.
- Accept one exact configured public origin and require the proxy to preserve
  the public `Host` header.
- Keep Codex manual approvals as a third, independent execution gate.

Cloudflare is a supported deployment option rather than a mandatory product
dependency; a properly configured VPN or SSH tunnel remains valid.

## Consequences

- A tunnel deployment does not require a public listener on the host.
- Remote access depends on Cloudflare identity, the application token, and
  Codex approval at distinct stages.
- Operators must protect two different tokens: the cloudflared connector token
  and the Ask Codex application token.
- Proxy rewrites that replace the public Host or use an inexact Origin fail
  closed and require configuration correction.
- Losing Access or leaking one token does not by itself remove every gate, but
  it still requires immediate investigation and credential rotation.

## Alternatives Considered

- Bind Ask Codex directly to a public interface: rejected because it needlessly
  exposes the application and host network.
- Trust Cloudflare Access without an application token: rejected because proxy
  and Access configuration are outside the application boundary.
- Use only an application token on a public listener: rejected because it lacks
  edge identity, MFA, and tunnel isolation.
- Put the token in a query parameter: rejected because URLs commonly appear in
  browser history, logs, screenshots, and intermediary telemetry.
