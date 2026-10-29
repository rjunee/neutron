## 2026-10-29 — README rewritten as the project's front page; issue templates; profile README draft

### What changed

- **`README.md`** was restructured around a short top section (what Neutron is,
  who it is for, why it exists), a Mermaid architecture diagram, a feature list
  in which every item names the directory that implements it, a Trident section,
  and a corrected quickstart. Internal history (removed Cores, removed shims,
  "being finalized ahead of launch") was dropped. Links to the three
  background posts and to Neutron Enterprise were added; the Enterprise link is a
  placeholder repository URL until the real one is chosen.
- **`.github/ISSUE_TEMPLATE/`** (new): bug and feature forms plus a `config.yml`
  that disables blank issues and routes security reports to GitHub private
  vulnerability reporting (confirmed enabled on the repository). The forms say
  issues are the inbox and that acceptance criteria live in `docs/spec-items/`,
  matching `docs/process/work-tracking.md`.
- **`docs/release/profile-README.md`** (new): a draft profile README for a
  separate repository that has not been created.
- **`IMPLEMENTATION_PLAN.md`** (root) removed: a Trident run's resume plan for
  PR #487 (2026-09-11), stale since that PR merged. Trident regenerates the file
  per branch; `open/wiring/project-build.ts:222` already tells agents not to
  write a repo-root copy, and no test reads the tracked root file (the tests
  that name it write their own into temporary repositories).

### Corrections the old README needed, found by reading the code

- The REPL host defaults to herdr, not an in-process PTY:
  `runtime/adapters/claude-code/persistent/configured-pty-host.ts:11-15` maps an
  unset `NEUTRON_REPL_HOST` to `herdrHost`; `bun` selects the retained PTY host
  (Decisions Log 2026-09-12). `install.sh` contains no herdr step (grep for
  `herdr` in it returns nothing), so the README now lists herdr as a
  prerequisite (`brew install herdr`) with `NEUTRON_REPL_HOST=bun` as the
  no-herdr route. The installer not provisioning the default host is a gap,
  recorded here, not fixed.
- A piped install does not auto-start when Claude is unauthenticated: it holds
  the service and the start until auth and tells the user to run
  `neutron install` (observed below; `bin/neutron:86` dispatches `install`).
- The `/healthz` sample was wrong; the real body carries more fields and reports
  `degraded` when memory is unavailable.

### Quickstart verification — exactly what ran

On an isolated `HOME` and port 7893, from a fresh `git clone --depth 1` of
`095fd44a`:

1. `sh install.sh --yes --no-service --no-backup --no-open --no-gbrain --no-codex`
   exited 0: dependencies installed, `.env` written, 162 migrations applied, then
   it stopped at the Claude-auth step without starting the server, as described.
2. `NEUTRON_REPL_HOST=bun bun run start` booted and served
   `GET /healthz` →
   `{"status":"degraded","project_slug":"dev","uptime_ms":2519,"memory":"unavailable",...}`
   (degraded because `gbrain` was skipped), and `GET /chat` → 302 → the
   "Authenticate Claude" onboarding page.
3. Six of nine bundled Cores installed. Calendar, email and Google Workspace
   refused without their OAuth secrets, which is their manifest contract.

**Not exercised:** a first chat turn (it needs a real Claude credential), the
herdr host path, the launchd/systemd service, and the interactive
`claude setup-token` branch of the installer.

### Hygiene checks

- Secrets: `git grep -E` over `origin/main` for Anthropic, GitHub, AWS, Slack,
  OpenAI and Google key shapes plus PEM private-key headers. The only hits
  outside tests and fixtures are a placeholder string
  (`app/features/admin/BackupPane.tsx:439`) and a PEM-prefix check
  (`open/connect-node-identity.ts:97`). The same pattern matches 13 lines across
  the tree, so it does find what it is looking for.
- CI badge: `ci.yml` exists and its latest `main` run (`095fd44a`) is green.
