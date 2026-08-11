# ADR 0025: Prioritize chrome-less mobile launch over PWA installation

- Status: Accepted
- Decision date: 2026-08-11

## Context

Ask Codex's mobile goal is to maximize the usable conversation workspace. The
key acceptance criterion is launching from the Android home screen without the
Chrome address bar, not registration as a WebAPK, offline support, or complete
PWA installability.

On the public Origin protected by Cloudflare Access, Android Chrome originally
created an Add to Home screen entry with the existing robot favicon and launched
it without an address bar. An experiment then added a Web App Manifest and
formal installation icons. Recreating the entry on the same phone instead
produced a gray account-initial icon and opened with the address bar in a normal
Chrome window. That behavior is consistent with Chrome falling back to Create
shortcut.

During the experiment, a local request using the trusted public `Host` could
retrieve the correct Manifest, while a public request without an Access cookie
received a Cloudflare Access `302` HTML login redirect. This evidence shows that
Access may affect Chrome's installation-resource fetch or launch transition,
but it does not prove that Access is the only cause. After the Manifest and
installation icons were removed, recreating the entry on the same physical
device restored both the robot icon and the address-bar-free launch.

## Decision

- Do not currently ship a Web App Manifest, PWA installation icons, or a Service
  Worker, and do not describe Ask Codex as an offline-capable PWA or promise a
  WebAPK.
- Keep the existing favicon and treat Android Chrome's home-screen entry as a
  best-effort browser launch mode. Accept it based on the physical-device result:
  no address bar and a larger usable viewport, not its classification in Android
  App info.
- Never bypass, weaken, or split Cloudflare Access protection to improve PWA
  installability.
- Reconsider a Manifest only after controlled physical-device validation on the
  real public Origin protected by Access. Validation must cover deleting the old
  entry, completing Access authentication, first creation, asynchronous install
  completion, cold launch, and repeat launch, while checking the icon, final
  Origin, address-bar state, and authentication transitions.
- If an account-initial icon and address bar appear, delete only that failed
  entry, authenticate with Access in Chrome, reopen Ask Codex, and create it
  again. Do not make clearing site data a routine troubleshooting step because
  it deletes the bounded attachment previews and download copies stored in
  same-Origin IndexedDB.

## Rationale

The simpler home-screen path already meets the user's actual requirement, while
the formal Manifest directly broke the most important result in the only tested
device and deployment combination. Keeping a Manifest that provides no current
value and may involve the Cloudflare Access login transition in Chrome's install
decision would produce a worse mobile experience than omitting the PWA label.

This decision does not turn one device observation into a general browser or
Cloudflare guarantee. It leaves room for later validation while requiring any
future PWA work to prove that it preserves both chrome-less launch and the
existing access boundary.

## Consequences

- The tested Android Chrome device again launches with the robot icon and no
  address bar, meeting the primary viewport goal.
- Chrome menu labels, creation delay, launch mode, and icon may vary by browser
  version, profile, or device. The project does not promise a system WebAPK or a
  stable Install app menu entry.
- Ask Codex has no offline cache. Cloudflare Access and the Ask Codex token still
  require authentication when their respective sessions expire.
- A future developer must not reintroduce a Manifest merely because the mobile
  launch resembles an app; the physical-device gate above must pass first.

## Alternatives Considered

- Keep the Manifest and formal installation icons: rejected for now because the
  tested path regressed to an account-initial icon and an address bar.
- Exempt the Manifest, icons, or launch URL from Cloudflare Access: rejected
  because installation convenience cannot weaken the independent outer identity
  gate, and exposing some install resources would not guarantee a standalone
  authenticated launch.
- Add a Service Worker to improve PWA eligibility: rejected because offline
  behavior is not required and it would add cache state around authentication,
  frontend updates, and a sensitive session.
- Use a Trusted Web Activity or native wrapper: deferred because the current
  home-screen entry meets the core goal, while native packaging, signing, and
  distribution would substantially expand maintenance scope.
