## 2026-09-15 — Issue 649: short-lived token measurement blocked

### Result and scope

**Unmeasured. Issue 649 remains open.** This change records the investigation;
it does not establish whether a fresh access token alone can authenticate a turn.
The task requires a live request with a known-fresh subscription access token,
without refreshing the shared live credential. This lane explicitly has no network
access. A presence-only inspection of the process environment found
`CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`, and `OPENAI_API_TOKEN` unset or empty;
`codex` and `bun` were available. This is an environment observation, not a claim
that credentials do not exist elsewhere. Shared credential files were not read,
changed, copied, or refreshed during this investigation.

Required prerequisite: an independently obtained fresh subscription access token,
with issuance and expiry evidence, securely supplied to an environment permitted
to reach the provider. Do not place that token in this record or a task brief.

### Evidence checked in this session

- The earlier inconclusive experiment is recorded at
  `docs/as-built/codex-work-runs-headless-per-call-on-a-reused-thread.md:340`.
  Its eight-day token and 401 are historical evidence, not a rerun in this lane.
- The current target leaves token-only authentication unresolved at
  `docs/spec-items/codex-work-runs-headless-per-call-on-a-reused-thread.md:125`.
- The build invocation uses full access at `trident/codex-build.sh:1449`.
  The spike's reference to lines 1401–1402 has moved.
- The warning against copying a seat because refresh rotates credentials remains
  at `trident/codex-credential.ts:396`; seat selection is at
  `trident/codex-credential.ts:401`.
- The project-home function is now at `trident/codex-auth.ts:266`, with the return
  at line 277, rather than the spike's line 191.

The filed brief has no numeric source citations. The corrections above concern
its supporting spike. A whole-tree Markdown search for
`trident/codex-build.sh:1401-1402|trident/codex-auth.ts:191` found references in
`SPEC.md:535`, the supporting spec item at lines 117 and 139, and its as-built
record at lines 195 and 331. Historical records remain immutable; current-target
citations are reported here without changing a product decision in a blocked
measurement. These are the hits enumerated by that exact search, not an audit of
all citations in the repository.

### Measurement handoff

Before a live attempt, capture the exact child environment at the spawn boundary
in the supervising process. Resolve its credential location there and assert the
credential file is absent before spawning, with an existing-file positive control.
Do not accept a child-written report as evidence of its startup environment.
Record issuance time, expiry, observation time, and age immediately before spawn;
file modification time alone is not token issuance evidence. Retain only redacted
metadata, CLI version, command shape, exit status, and provider outcome.

A completed authenticated turn would support the channel for that tested setup.
A known-fresh 401 would leave unsupported-channel versus additional-required-input
unresolved. Network failure, missing age evidence, and preflight refusal remain
inconclusive. An empty temporary home alone would not establish that an unconfined
turn cannot read shared credentials elsewhere; the live experiment must arrange
that boundary without disturbing shared work before claiming the residual closed.

### Decisions and deliberately omitted work

Production authentication was not changed before the prerequisite measurement.
No new runtime outcome or invariant was introduced. No API key was substituted
for subscription authentication, and no confinement claim was made. No migration,
new test, or runtime guard was added; synthetic success cannot answer the live
provider question. The staged diff enumerates this record as the only changed file.
The requested lane-specific record location takes precedence over the general
record location in `docs/process/work-tracking.md:131`.

### Validation and mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Not applicable: documentation-only blocked investigation | None | Not run | Not claimed |

- `bun test tests/integration/identity-env-readers-registry.test.ts`: 21 passed,
  0 failed. This validates the existing registry, not token-only authentication.
- `bun run typecheck`: exit 1, script not found. The root script declarations are
  at `package.json:57`. Positive-control search
  `rg -n '"typecheck"|"test:bun"' package.json` found `test:bun` at line 61
  and no typecheck script.
- Direct local fallback `./node_modules/.bin/tsc --noEmit -p tsconfig.json`: exit 0.
- The full test suite was not run, per the bounded validation instruction.
