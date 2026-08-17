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
bash scripts/select-tests-for-changes.sh main 40 | xargs bun test   # just what you changed
```

The last one is the fast local pass: it prints the test files covering your
working tree's changes (changed test files, the tests beside each changed module,
then tests that name a changed module — capped). It is the right default while
iterating, especially on a busy machine. CI runs the whole suite on every push
regardless, so it is a way of finding breakage sooner, never a way of skipping it.

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

### Merge driver for the AS_BUILT log (anyone)

```sh
bash scripts/install-merge-drivers.sh            # install
bash scripts/install-merge-drivers.sh --check    # is THE CURRENT driver installed?
bash scripts/install-merge-drivers.sh --uninstall
```

`--check` compares the command your clone actually has against the one the
installer writes today, so a clone that ran an older version of this script is
reported `STALE` rather than `installed`. The remedy it prints is the install
command above — it is idempotent, so re-running it is always safe.

`docs/AS_BUILT.md` is newest-first, so every change prepends its entry at the
same offset under the same header lines. Two branches doing that conflict by
construction rather than by bad luck — on 2026-08-15 three concurrent builds
failed to publish on that file and nothing else. This installs an **entry-aware**
merge driver: it unions whole entries, so two branches that each added one get
both, newest first, with neither spliced into the other. Anything it will not
merge cleanly (both sides editing the same entry, a changed header) falls back
to `git merge-file` and the ordinary conflict markers.

Unlike the hook above, this needs no secret and is useful to anyone who rebases
a branch that touches the log. It is optional: **the attribute that binds the
driver to the path is written to `.git/info/attributes`, not to a tracked
`.gitattributes`**, so a clone that never runs this behaves exactly as it does
today. That is deliberate. `docs/AS_BUILT.md merge=union` is the tracked floor
every clone gets; committing `merge=as-built-log` on top would override it with
a driver nobody has configured, and — measured on git 2.50.1 — a clone with no
`merge.as-built-log.*` config falls back to the ordinary text merge, so the log
would quietly go back to conflicting for everyone who had not run the installer.
(A half-install, `merge.<name>.name` with no `.driver`, is the case that really
is `fatal: … lacks command line`, exit 128.) The attribute and its driver arrive
together or neither does: the installer checks every write, writes `.driver`
before `.name` — measured on git 2.50.1, `.driver` alone merges fine while
`.name` alone is the exit-128 abort — and rolls the pair back and exits non-zero
rather than reporting success over a partial install.

Trident's publisher runs this itself before replaying a branch, so builds get it
without anyone remembering.

## Pull requests

- Keep PRs focused: one concern per PR.
- Include tests for new behavior and bug fixes (a regression test that fails
  before your fix and passes after).
- Run `bash scripts/ci/typecheck-all.sh` before pushing, plus
  `bash scripts/select-tests-for-changes.sh main 40 | xargs bun test` for the
  tests covering your change (see [Tests](#tests) above). `bash scripts/run-tests.sh`
  is the whole suite and CI runs it on every push; run it locally when you want it,
  not because you have to.
- Match the style of the surrounding code (formatting, naming, comment density).
- Write clear commit messages explaining the why, not just the what.

## Reporting bugs

Open a GitHub issue with: what you did, what you expected, what happened, and
the relevant logs (server log lives under your data directory at
`<NEUTRON_HOME>/logs/server.log`). A minimal reproduction is gold.

For security issues, do NOT open a public issue: see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
