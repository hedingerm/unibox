# Unibox

A keyboard-driven macOS desktop client that merges **Gmail / Google Workspace accounts** and
**[Resend](https://resend.com) domains** into one inbox — read, organize, search and send, all
from a local SQLite database.

Built with Electron, React and TypeScript. The UI is currently in **German** (all strings go
through an i18n layer, so other languages can be added). Menu names in this README are
translated: *Settings* is *Verwaltung* in the app, *General* is *Allgemein*.

## Features

- **One merged inbox** across any number of Gmail accounts and Resend domains, with a per-account
  badge on every row. Each Resend domain behaves like its own account.
- **Two-way Gmail sync** via the Gmail REST API: archive, labels, read/unread, trash and spam go
  back to Gmail through an offline mutation queue. Send-as aliases and their signatures are
  picked up automatically; replies go out from the address the mail was sent to.
- **Resend as a mailbox**: enable receiving per domain, see the required MX record, and get
  incoming and sent mail by polling (Resend has no IMAP). A built-in admin area covers domains,
  DNS records, named mailboxes on top of the catch-all, routing rules, delivery status and
  webhooks.
- **Full local history** with FTS5 full-text search and Gmail-style operators (`from:`, `to:`,
  `has:attachment`, `account:`, …).
- **Compose** with rich text, templates, multiple signatures, undo send, scheduled send,
  follow-up reminders and snooze.
- **Optional AI helpers** powered by a locally installed [Claude Code](https://claude.com/claude-code)
  CLI: sort the inbox into your existing labels, and draft, rewrite or proofread mails in a voice
  you define. Nothing moves until you confirm it.
- Keyboard shortcuts for everything, a command palette (`⌘K`), dark mode, desktop notifications.

## Requirements

- macOS on Apple Silicon (release builds are arm64 only)
- [Bun](https://bun.sh) ≥ 1.2 and Node.js ≥ 22 to build from source
- For Gmail: your own Google OAuth client — see [Google OAuth setup](#google-oauth-setup)
- For Resend: a Resend API key
- Optional: the [`claude`](https://claude.com/claude-code) CLI for the AI features, the
  [`gh`](https://cli.github.com) CLI for in-app update checks

## Getting started

```bash
git clone https://github.com/hedingerm/unibox.git
cd unibox
bun install
bun run dev
```

To produce an installable app:

```bash
bun run dist        # builds dist/Unibox-<version>-arm64.dmg and .zip
```

Builds are ad-hoc signed and not notarized, so Gatekeeper will complain on first launch. Open
the app once via **System Settings → Privacy & Security → Open Anyway**, or remove the quarantine
flag: `xattr -dr com.apple.quarantine /Applications/Unibox.app`.

Prebuilt releases, if available, are on the
[Releases page](https://github.com/hedingerm/unibox/releases). `scripts/install.sh` downloads the
latest one into `/Applications` (requires `gh`).

## Google OAuth setup

### Why you need your own OAuth client

Unibox talks to Gmail through the official Gmail API instead of IMAP. That gives it labels,
threads, aliases and fast incremental sync. The catch is that Google requires every app using the
API to identify itself with an **OAuth client**. Gmail's `gmail.modify` scope is classified as
*restricted*. Shipping one shared client to the public would mean Google's app verification plus
a paid third-party security assessment (CASA).

So Unibox doesn't ship a client. Each user creates their own in a free Google Cloud project and
keeps it in **Testing** mode, which skips verification entirely. Your mail flows directly between
your Mac and Google. No server run by anyone else is involved.

### Step by step

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (any name, e.g. "Unibox").
2. **APIs & Services → Library**: search for **Gmail API** and enable it.
3. **Google Auth Platform → Branding / Audience** (formerly *OAuth consent screen*):
   - User type: **External** (or **Internal** if all your accounts are in one Workspace org).
   - Fill in the app name and your email; everything else can stay empty.
   - Publishing status: leave it on **Testing**.
   - Under **Test users**, add every Google account you want to connect to Unibox.
4. **Data Access** (scopes): add
   - `https://www.googleapis.com/auth/gmail.modify` — read, send and organize mail
   - `https://www.googleapis.com/auth/gmail.settings.basic` — read send-as aliases and signatures
5. **Clients → Create client**: application type **Desktop app**. Download the JSON file.
6. Save it as:

   ```
   ~/Library/Application Support/unibox/google-oauth.json
   ```

   Start Unibox once first if the folder doesn't exist yet. The downloaded file can be used
   as-is (the `installed` wrapper is understood). Alternatively, set `UNIBOX_GOOGLE_CLIENT_ID`
   and `UNIBOX_GOOGLE_CLIENT_SECRET` in the environment. This only works when Unibox is started
   from a terminal (e.g. `bun run dev`), because apps launched from Finder don't inherit your
   shell environment.
7. Restart Unibox and connect your account in onboarding (or **Settings → Accounts**).

### What to expect

- **Unverified-app warning.** Google shows "Google hasn't verified this app" during sign-in.
  That's expected for Testing mode: you are both the developer and the only user. Click
  **Continue**.
- **Weekly re-login.** In Testing mode, Google expires refresh tokens after **7 days**. Unibox
  detects this, marks the account as *reconnect required* and shows a banner. One click signs you
  back in; no mail is lost.
- **The client secret isn't really secret.** For desktop apps Google treats it as public. Unibox
  uses the loopback redirect with PKCE, which is Google's recommended flow for installed apps.
- **Where tokens live.** Refresh tokens and the Resend key are encrypted with Electron
  `safeStorage` (key in the macOS Keychain) and stored in `secrets.json`. They never touch the
  database or disk in plain text; tests enforce this.

## Resend setup

Enter your API key during onboarding. Unibox lists all domains on the account and lets you enable
receiving per domain. It shows the required MX record and re-checks verification automatically.
You can also create new domains from **Settings → Domains** and copy the DNS records from there.

> ⚠️ **MX conflict**: if a domain already has a different MX record (e.g. Google Workspace),
> Unibox refuses to enable receiving until you explicitly confirm. Otherwise all mail for that
> domain would be routed to Resend.

Resend has no push channel for a desktop app (webhooks need a public HTTPS endpoint), so Unibox
polls every 15 seconds. **Resend deletes received and sent mail after 30 days.** After that, your
local database is the only copy — see [Data and backups](#data-and-backups).

## AI features (optional)

The broom button in the toolbar (`s`) asks Claude to sort the inbox. For each conversation it
proposes a label, trash, spam or "leave in inbox". The proposals are based on where similar mail
from the same sender or with a similar subject went before. A single selected conversation is
filed right away, with undo. Anything larger opens a review list first.

In compose, Claude can draft, rewrite or proofread a mail. The writing style is a plain-text
prompt under **Settings → General**. It comes with a neutral default that you should rewrite in
your own voice.

Both features call the local `claude` CLI (`claude -p --output-format json`) as a child process:
no tools, no MCP servers, no user or project settings, in an empty working directory. Mail
content is treated as untrusted input, and nothing is applied without your confirmation. Model
and CLI path are configurable in the settings. Without the CLI, these features are simply
unavailable.

## Data and backups

Everything lives in `~/Library/Application Support/unibox/`:

| File / folder       | Contents                                                      |
| ------------------- | ------------------------------------------------------------- |
| `unibox.db`         | Complete mail history incl. full-text index (SQLite, WAL)     |
| `attachments/`      | Downloaded attachments                                        |
| `secrets.json`      | Google tokens and Resend key, encrypted via `safeStorage`     |
| `google-oauth.json` | Your OAuth client (see above)                                 |

**Back this folder up.** Time Machine includes it by default. For a manual snapshot, use
**Settings → General → Backup → Create backup**. It writes a consistent copy via `VACUUM INTO`
while the app keeps syncing. Copying `unibox.db` by hand would miss anything still in the WAL. To
restore, quit Unibox, put the copy in place as `unibox.db` and delete `unibox.db-wal` and
`unibox.db-shm`.

The attachment cache (**Settings → General**) can be cleared safely. Only Gmail attachments are
removed, since they can be re-downloaded. Resend attachments are originals and are kept.

## Keyboard shortcuts

| Key       | Action                                   |
| --------- | ---------------------------------------- |
| `j` / `k` | next / previous conversation             |
| `⇧J`/`⇧K` | extend selection                         |
| `x`       | toggle conversation in selection         |
| `e`       | archive                                  |
| `#`       | trash                                    |
| `!`       | mark as spam                             |
| `i` / `u` | mark read / unread                       |
| `r`       | reply                                    |
| `f`       | forward                                  |
| `s`       | sort with AI                             |
| `b`       | snooze                                   |
| `c` / `⌘N`| new mail                                 |
| `g` + `i`/`s`/`t`/`d`/`z`/`a`/`!`/`#`/`v` | go to Inbox, Starred, Sent, Drafts, Snoozed, Archive, Spam, Trash, Settings |
| `/`       | search                                   |
| `⌘K`      | command palette                          |
| `?`       | show all shortcuts                       |

Actions apply to the whole selection. `⇧`-click selects a range, `⌘`-click toggles single
conversations.

## Development

```bash
bun run dev         # Electron with HMR
bun run typecheck   # tsc for main/preload and renderer
bun run lint        # ESLint (incl. React Compiler rules)
bun run test        # Vitest: unit, integration and renderer tests
bun run seed:demo   # demo data in .tmp/demo — explore the UI without real accounts
bun run smoke       # launch the built app, verify it mounts, write .tmp/unibox.png
```

```
src/main      Electron main process: SQLite (db/), Gmail (google/), Resend (resend/),
              MIME builder (mime/), outbox (send/), offline mutation queue, IPC API (app.ts)
src/preload   contextIsolation bridge exposing only the declared IPC channels
src/renderer  React UI, German via the i18n layer (src/renderer/src/i18n)
src/shared    Types and the IPC contract shared by both sides
test/         Vitest suites; Gmail and Resend are faked in-process (test/helpers)
```

Gmail labels are the shared model: Resend domains also get the system labels
`INBOX`/`SENT`/`UNREAD`/`TRASH`/`SPAM`, so lists, folders and counters use one code path for
both account types. For Resend these states stay local, while for Gmail they sync back.

Design decisions and their reasoning are documented (in German) in [`CONTEXT.md`](CONTEXT.md).
See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Known limitations

- **macOS only**, Apple Silicon builds only.
- **Scheduled send needs the app running.** There is no server; missed send times are caught up
  on the next launch.
- **Resend threading** relies on `Message-ID` / `In-Reply-To` / `References`. Mails without
  these headers become their own conversations.
- **Weekly Google re-login** while your OAuth client is in Testing mode (see above).
- **No auto-update.** Without a Developer ID certificate and notarization, macOS doesn't allow
  silent self-replacement. Unibox can check GitHub releases via `gh` and run the bundled
  install script instead.

## License

[MIT](LICENSE)
