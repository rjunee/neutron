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

## Pull requests

- Keep PRs focused: one concern per PR.
- Include tests for new behavior and bug fixes (a regression test that fails
  before your fix and passes after).
- Run `bash scripts/ci/typecheck-all.sh` and `bash scripts/run-tests.sh` before
  pushing (see [Tests](#tests) above) — these are the same commands CI runs.
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
