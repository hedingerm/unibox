# Contributing to Unibox

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs and feature ideas**: open an [issue](https://github.com/hedingerm/unibox/issues/new/choose)
  first, especially for larger changes, so we can agree on the approach before you invest time.
- **Security issues**: never as a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need macOS, [Bun](https://bun.sh) ≥ 1.2 and Node.js ≥ 22.

```bash
bun install
bun run dev         # Electron with HMR
```

You don't need real accounts to work on most of the app:

```bash
bun run seed:demo   # fills .tmp/demo with demo accounts and mail
```

For Gmail, create your own OAuth client as described in the
[README](README.md#google-oauth-setup). For Resend, a free account with a test domain is enough.

## Checks

Every pull request must pass:

```bash
bun run typecheck
bun run lint
bun run test
```

CI runs the same three commands on macOS.

## Guidelines

- **Tests**: new behavior comes with tests. Gmail and Resend are faked in-process
  (`test/helpers/fake-gmail.ts`, `test/helpers/fake-resend.ts`), and renderer tests bind
  `window.unibox` to the real app core. Test through those rather than mocking internals.
- **TypeScript**: strict, no `any` unless there's truly no alternative.
- **UI strings**: all user-facing text goes through the i18n layer
  (`src/renderer/src/i18n`). A test scans for hard-coded strings.
- **IPC**: new channels are declared in the shared contract (`src/shared`) and exposed
  through the preload bridge. The renderer never gets direct Node access.
- **Mail content is untrusted**: sanitize HTML, never execute or follow anything from a mail
  without user action, and keep the AI subprocess sandboxed.
- **No real data**: use `example.com` addresses and made-up names in tests, fixtures and
  screenshots.
- **Keep it simple**: prefer the smallest change that solves the problem, and match the style
  of the surrounding code.
- Design decisions and their reasoning are recorded in [`CONTEXT.md`](CONTEXT.md) (German).
  If your change alters one of them, update it there.

## Pull requests

- One topic per PR; keep them focused.
- Describe *what* changed and *why*, and link the issue.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(scope): …`, `fix(scope): …`).

## Releasing (maintainers)

```bash
bun run release              # patch: 0.3.3 -> 0.3.4
bun run release minor        # 0.3.3 -> 0.4.0
bun run release 1.0.0        # explicit version
```

`scripts/release.sh` runs the checks, bumps `package.json`, tags `vX.Y.Z`, pushes, builds the
arm64 bundle and uploads the `.dmg` and `.zip` to a GitHub release (requires `gh auth login` and
a clean worktree).

On the install side, `scripts/install.sh` fetches the latest release into `/Applications`
(`--quit`, `--relaunch`, `--force`). `scripts/setup-login-update.sh` installs a launch agent
that runs it at every login (`--remove` to uninstall). The app itself also checks for updates
via `gh` shortly after launch and from *Unibox → Nach Updates suchen…*.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
