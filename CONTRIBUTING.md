# Contributing to Neutron

Thanks for your interest in Neutron, an agent harness for Claude Code. Neutron
orchestrates your own Claude Code sessions and wraps them with persistent
memory, projects, scheduled and autonomous jobs, and reminders, reachable from a
web app (or Telegram).

> Neutron is pre-release and under active development. Internals and interfaces
> change frequently. If you are filing an issue or opening a PR, expect things to
> move under you for now.

## Ways to contribute

- File an issue for a bug or a concrete proposal (see "Reporting bugs" below).
- Open a pull request for a focused fix or improvement.
- Improve docs.

For anything large or architectural, open an issue first to discuss direction
before writing code, so we do not both build the same thing twice.

## Development setup

Requirements:

- [Bun](https://bun.sh) (the runtime and test runner).
- The `claude` CLI (Claude Code), authenticated with your own subscription
  (`claude setup-token`). Neutron runs on your own Claude credentials.
- `git`.

Get a local instance running from a checkout:

```sh
sh install.sh          # installs in place from this checkout, then starts it
```

Or run the pieces directly:

```sh
bun install
bun run migrate        # create / migrate the local database
bun run start          # onboarding + chat at http://127.0.0.1:7800/chat
```

## Tests

Do NOT run bare `bun test` for the whole suite — it loads every discovered file
into one long-lived process and its peak memory footprint will OOM most
machines (the suite has grown past 800+ files). Use the partitioned runner
instead, which runs the same suite to completion in bounded memory:

```sh
bash scripts/run-tests.sh          # the whole suite, bounded memory (what CI runs)
bun test path/to/dir               # a subset while iterating (fine, cheap)
bun test path/to/file.test.ts      # a single file (fine, cheap)
```

See `docs/testing-runner.md` for tuning knobs (chunk size, concurrency, the
PGLite quarantine lane) if a run is slow or your box has limited RAM.

To reproduce the full CI gate locally, run the same steps CI runs
(`.github/workflows/ci.yml`):

```sh
bash scripts/ci/typecheck-all.sh    # type-check EVERY tsconfig.json in the repo
                                    # (not just the root — leaf packages like
                                    # trident/, app/, landing/chat-react/ have
                                    # their own configs and real errors there)
bash scripts/run-tests.sh           # the partitioned test suite
bash scripts/ci/leak-gate.sh --tree .   # public-repo purity gate
bash scripts/ci/depcruise.sh        # layering / cross-band import ratchet
```

Please keep the suite green. New behavior needs a real test that asserts the
actual observable outcome (a rendered result, a row on disk, an HTTP status),
not just internal bookkeeping. A test that passes while the feature is broken is
worse than no test.

### Git hooks (maintainers)

```sh
bash scripts/install-git-hooks.sh    # arm .githooks/ (pre-push leak gate)
bash scripts/install-git-hooks.sh --uninstall
```

The pre-push hook runs `scripts/ci/leak-gate.sh --messages-only` over the commit
messages you are about to publish. It exists because a public push is copied to
GHArchive/BigQuery within the hour: a bad file can be force-pushed away and is
blocked by CI before a merge, but **a commit message or PR body can never be
taken back by anyone**. CI was the first place that check ran, and CI runs after
the push.

The rule needs a denylist of owner proper nouns, which is a repository secret and
therefore not in this repo. The hook reads a plain-text copy from
`${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist` — deliberately
outside every working tree, so that no `git add` in any repository can pick it
up. The installer refuses to arm the hook without one rather than blocking every
push with a failure you cannot act on.

**If you are an outside contributor you do not need this hook** — you have
nothing to put in that file, and CI runs the same gate on your PR.

A leak-gate run that has no denylist now reports `LEAK GATE: INCOMPLETE` and
exits **3**, not `SILENT ✅`. That is not a failure of your change: it means the
PII rule could not run, and "I could not check" must not look like "I checked and
it was clean". Exit codes: `0` clean, `1` findings, `2` config error, `3`
incomplete.

A PR title/body never passes through git, so no hook can see one. Check it before
you publish it:

```sh
LEAK_GATE_PR_BODY="$(cat pr-body.md)" bash scripts/ci/leak-gate.sh --messages-only
```

### The as-built log has ONE writer (anyone)

`docs/AS_BUILT.md` is the canonical, newest-first build log and the **only**
place to read it. It has one entry per merged change, headed
`## YYYY-MM-DD — title`.

Do not edit `docs/AS_BUILT.md` on a branch or PR, ever. Every build prepending
at the same offset made any two open PRs conflict by construction, and GitHub
never runs merge drivers server-side, so no local driver could fix the
mergeability check. CI fails any PR whose diff touches the file.

Instead, stage exactly one entry as `.trident/as-built/<branch>.md`, mirroring
the branch name as directories under `.trident/as-built/` just as
`.trident/plans/` does. That gives every branch a unique path, so concurrent PRs
cannot collide. The first non-blank line must be a single
`## YYYY-MM-DD — title` heading (with spaces around the em dash), followed by
the body. Put nothing above the heading and exactly one entry in the file.

After the merge lands, the outer loop folds every staged entry directly into
`docs/AS_BUILT.md` on main, oldest-landed first so the newest ends topmost, and
deletes each consumed staging file in the same commit. A colliding heading is
retitled with the first free ` (n)` suffix. The staging directory is a consumed
queue, never a second place to read the log.

## Pull requests

- Keep PRs focused: one concern per PR.
- Include tests for new behavior and bug fixes (a regression test that fails
  before your fix and passes after).
- Run `bash scripts/ci/typecheck-all.sh` and `bash scripts/run-tests.sh` before
  pushing (see [Tests](#tests) above) — these are the same commands CI runs.
- Match the style of the surrounding code (formatting, naming, comment density).
- Write clear commit messages explaining the why, not just the what.

### If your change adds a status, a guard, or a delegation

Three obligations, from `docs/INVARIANTS.md` §12 (the honesty contract) and §13 (the action
contract). They are written down because the same defect has landed here repeatedly under
different names.

- **A status a caller reads must be able to say "I don't know."** If a value is stored rather than
  probed, it carries when it was observed; a probe that could not conclude reports UNKNOWN with a
  reason, never an implicit negative and never an implicit pass. The precedent is already in this
  file: the leak gate exits **3** with `LEAK GATE: INCOMPLETE`, because "I could not check" must
  not look like "I checked and it was clean". `GLOSSARY.md` → "Names whose plain reading is false"
  lists the names that got this wrong. Do not add to it.
- **A new guard ships with its honest sibling and a must-fail control.** Naming the shape you
  refuse is half the work; the other half is naming the row that gets written *instead*, and
  showing in a test that a writer can actually produce it. A refusal with no writable alternative
  is a deadlock, not a safeguard — `trident/store.ts:1225-1245` records the one this repo already
  shipped, a run that "retried forever" against a guard reading a column its own writer could not
  populate. On the must-fail control, see `docs/testing-runner.md`.
- **A no-op must be distinguishable from a success.** Do not return a bare `{ ok: true }` from a
  write path. Say what changed, or that it was already so, or that it was correctly a no-op — or
  refuse, naming the precondition that failed and the layer that refused.

And when you fix a defect, prefer the fix that binds to the **class of construction site** over the
one that patches the caller that taught you about it. A guard bolted onto one caller is a note; a
requirement at the site where the object is built is a floor the next contributor inherits without
having read this file.

## Reporting bugs

Open a GitHub issue with: what you did, what you expected, what happened, and
the relevant logs (server log lives under your data directory at
`<NEUTRON_HOME>/logs/server.log`). A minimal reproduction is gold.

For security issues, do NOT open a public issue: see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
