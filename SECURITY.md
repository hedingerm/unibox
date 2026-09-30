# Security Policy

Unibox handles OAuth tokens, API keys and the full contents of your mailboxes, so security
reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report them privately through GitHub:
**[Report a vulnerability](https://github.com/hedingerm/unibox/security/advisories/new)**
(Security tab → *Report a vulnerability*).

Please include:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- the Unibox version and macOS version
- any suggested fix, if you have one

Don't include real mail content, tokens or keys. Redact them or use test accounts.

You can expect an acknowledgement within a week. Once a fix is released, you'll be credited in
the advisory unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

Examples of what's in scope:

- leaking credentials (Google tokens, Resend key) outside the encrypted `secrets.json`
- script execution or data exfiltration through rendered mail content (HTML sanitizing,
  remote content, links)
- escaping the preload / IPC boundary from the renderer
- getting the AI helpers (the sandboxed `claude` CLI) to act on mail content without user
  confirmation
- flaws in the OAuth flow (PKCE, loopback redirect)

Out of scope:

- issues that need an already compromised macOS user account
- the unverified-app warning and weekly re-login of Google OAuth clients in Testing mode (by
  design, see the README)
- missing code signing / notarization of release builds (a known limitation)
