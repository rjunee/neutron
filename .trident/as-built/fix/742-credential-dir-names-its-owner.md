## 2026-09-14 — Codex project credential directories name their owner (#742)

### Root cause and implementation

The full issue brief was read; it supplied no numeric citations needing correction.
The 128-bit key is minted at `trident/codex-auth.ts:271`, truncated at :274 and
used to derive the directory at :276. Before this change,
`rg -n 'owner|mismatch|codexProjectHome' trident/codex-auth.ts` found the positive
control `codexProjectHome` at :265 and global owner-home documentation, but no
project-directory owner comparison. Production call sites were enumerated with
`rg -n 'codexProjectHome' --glob '*.ts' --glob '!*.test.ts'`: the four service
construction sites were the only executable callers outside the definition.
This is a source-checkout finding, not a claim about a freshly fetched remote ref.

`trident/codex-project-owner.ts:32` creates new project directories exclusively
and writes the complete project id as a JSON string in `project-owner.json`.
`trident/codex-project-owner.ts:21` reads and compares it on every access; absent,
unparseable and mismatched markers throw `CodexProjectOwnerError`. A crash between
directory and marker creation leaves a refusal, not an adoptable directory (:42).
Marker writes use mode 0600 (:43); new directories use mode 0700 (:37).

All service project-directory sites now call this verifier, enumerated by
`rg -n 'ownedCodexProjectHome' trident/codex-credential.ts`: :386 (connect/delete),
:465 (status), :518 (probe), :746 (run resolution). Connect and disconnect also
check before modifying the credential store (:435, :725). Their later path
resolution checks again after the asynchronous store operation (:448, :727).
Status can create a missing directory with its marker, as documented at :454.
The owner need not be alive or cooperating: each requesting service call rereads
the durable marker. There is no successful-check cache.

### Refusal vocabulary and consumer defaults

The new code `codex_project_owner_refused` is a configuration exception
(`trident/codex-project-owner.ts:8`), not the resolver's `null`/not-connected
outcome. Consumer enumeration used `rg -n 'resolveActiveCodexHome|refreshSeatLiveness'
--glob '*.ts' --glob '!*.test.ts'` plus the four construction sites above.

- HTTP joins the existing `jsonError(status, code, message)` vocabulary as 409
  (`gateway/http/codex-credential-surface.ts:208`). The web client's generic
  non-success handling preserves unknown codes in `CodexClientError`
  (`landing/chat-react/codex-credential-client.ts:202`). The mobile equivalent
  does likewise (`app/lib/codex-credential-client.ts:167`), although its current
  routes are global (:94).
- The production run closure propagates the exception
  (`trident/codex-credential.ts:1393`). Ordinary launch resolves before invoking
  the workflow (`trident/orchestrator.ts:4668`). Its existing launch-fault taxonomy
  retries visibly and then records non-retryable `failed` (:6270); crash recovery
  uses the same default (:5663). This deliberately retains that bounded retry
  policy instead of introducing another run state.
- Bound review formerly swallowed all resolver errors and selected the static
  fallback. It now rethrows this exception (`trident/orchestrator.ts:3779`) into
  that same launch-fault handling. Other exception defaults are unchanged.
- Background liveness uses `fireAndForget` (`trident/codex-credential.ts:571`),
  which logs and counts rejection (`logger/fire-and-forget.ts:132`). It never
  proceeds to the mismatched directory's probe (:518).
- Agent tools call global status/connect only (`trident/codex-credential-tool.ts:117`,
  :154); they do not select a project directory. Their "never throws" probe
  comment remains scoped to that global call. The corrected project-status
  comment was found by `rg -n 'Read-only connection status|never throws: an unreachable endpoint'`;
  the global-tool comment was the other hit and remains for this reason.

### Migration decision and limits

Explicit offline migration is required for existing unmarked project directories.
This pauses affected overrides until the operator establishes their project id
independently. Neither the derived hash nor a ChatGPT account id proves project
identity. No automatic adoption or stale credential reconstruction is attempted.
`migrateCodexProjectOwner` writes only a missing marker, refuses a different owner
and reports same-owner no-op (`trident/codex-project-owner.ts:54`). The documented
command in `docs/codex-project-owner-migration.md` was executed on a disposable
fixture and returned `changed: true`.

The copy rehearsal preserves refreshed auth bytes and resolves the copied
credential through a real service while leaving the original unmarked
(`trident/codex-credential.test.ts:590`). Lower-level copy/idempotence/refusal
coverage is at `trident/codex-project-owner.test.ts:28` and :43. The operator must
stop writers during migration. This does not defend against a malicious actor
able to rewrite the credential directory, nor retroactively stop a CLI already
running against it. Disconnect retains the ownership marker: only auth.json is
removed (`trident/codex-auth.ts:326`).

SPEC.md records the 2026-09-14 #742 decision; the new spec item carries acceptance.
The total path derivation and socket-length decision remain intact. No change to
global seat selection, credential encryption, hash width, or socket behavior was
made. No remote actions were attempted. The lane's explicit record-location rule
selects this staging shard instead of a second record under docs/as-built.

### Tests and mutation table

Each row was mutated independently, printed at the actual landed source line,
run RED (exit 1), restored, and run GREEN (exit 0). Caller mutation line numbers
include the extra temporary import; final source lines are listed above.

| Guard | Mutation and landed line | Red | Restored |
|---|---|---|---|
| Project-id grammar | owner module :17 condition false | 1 | 0 |
| Full owner comparison | owner module :28 condition false | 1 | 0 |
| Missing/malformed marker | owner module :26 return instead of throw | 1 | 0 |
| No implicit legacy adoption | owner module :42 always write marker | 1 | 0 |
| Immutable migration marker | owner module :57 `wx` becomes `w` | 1 | 0 |
| Connect preflight | service :435 removed | 1 | 0 |
| Disconnect preflight | service :724 removed (now :725) | 1 | 0 |
| HTTP mapping | HTTP surface :208 condition false | 1 | 0 |
| Write/delete owner path | service :387 replaced with pure path derivation | 1 | 0 |
| Status owner path | service :465 replaced with pure path derivation | 1 | 0 |
| Probe owner path | service :518 replaced with pure path derivation | 1 | 0 |
| Run owner path | service :746 replaced with pure path derivation | 1 | 0 |
| Bound-review refusal | orchestrator :3779 rethrow removed | 1 | 0 |

Owner success and mismatch refusal share fixtures
(`trident/codex-project-owner.test.ts:16`, `trident/codex-credential.test.ts:567`).
The write-path mutation also breaks marker creation on the initial connect;
preflight mutations separately prove no store overwrite or deletion on refusal.
The bound-review fixture reaches the resolver and proves no review executes until
repair (`trident/review-run.test.ts:557`). No assertion was loosened or skipped.

Validation:

- `bun test trident/codex-project-owner.test.ts trident/codex-credential.test.ts gateway/http/codex-credential-surface.test.ts trident/codex-auth.test.ts`: 80 pass, exit 0.
- `bun test trident/review-run.test.ts`: 14 pass, exit 0.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations pass, exit 0.
  Final `bunx tsc --noEmit -p trident/tsconfig.json`: exit 0 after the review change.
- `bash scripts/ci/lint.sh`: exit 0, including a final run after the review change.
- Additional `bun test trident/codex-rotation.test.ts trident/__tests__/codex-seat-probe.test.ts scripts/__tests__/spec-items-index.test.ts`:
  163 pass, zero assertion failures, two suite-load errors, exit 1. The unchanged
  probe file cannot start its local HTTP listeners (:1370, :1550) in this sandbox.
  This additional run is not reported as green.
- Leak gate: exit 3, zero findings from rules run, INCOMPLETE because private
  PII denylist rules could not run. Complete certification needs the orchestrator's
  out-of-band denylist. No denylist was invented or bypassed.
