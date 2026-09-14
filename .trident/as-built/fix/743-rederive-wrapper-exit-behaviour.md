## Issue #743 — re-derive the Codex daemon exit behavior

### Outcome

No runtime wrapper change remains to build. The subject is codex-cli 0.154.0, recorded in
the measurement comment at `trident/codex-auth.ts:41-46` and in the superseding decision
at `SPEC.md:290`. Run without a pipe, `codex app-server daemon version` returned exit 1
for all three measured failures: a 107-byte derived socket pathname that reached connect,
the 108-byte pathname refused with `path must be shorter than SUN_LEN`, and an ordinary
missing socket. The old exit-0 observation was taken against 0.149.1 and no longer
describes the installed CLI.

The socket limit does not change. `CODEX_CONTROL_SOCKET_PATH_MAX_BYTES` remains 107 at
`trident/codex-auth.ts:54`; the adjacent comment records that 107 reaches the connection
attempt while 108 receives the length refusal (`trident/codex-auth.ts:41-46`). The guard
still measures the complete UTF-8 pathname and throws above the limit
(`trident/codex-auth.ts:99-102`).

### Complete caller enumeration

Production callers were enumerated with the same search over all TypeScript and shell
files beneath `trident/` and `runtime/`, excluding test files:

`rg -n --glob '*.ts' --glob '*.sh' --glob '!*.test.ts' --glob '!*.spec.ts' 'app-server daemon version|codex exec' trident runtime`

The positive control found the production wrapper invocations at
`trident/codex-build.sh:1446` and `trident/codex-review.sh:537`. The daemon-version arm
found only its measurement comment at `trident/codex-auth.ts:42`; there is no production
daemon invocation to harden. The existing wrappers are a different command surface:
the build wrapper turns a non-zero `codex exec` into exit 5 at
`trident/codex-build.sh:1445-1456`, and the review wrapper does the same at
`trident/codex-review.sh:553-557`.

### Decision

The proposed second half of #637 is closed without runtime code. Adding a content parser
or a second success criterion around a command that now returns a conventional failure
would preserve machinery for a stale CLI behavior, while no current caller could use it.
The immutable earlier decision remains in place; a newest-first entry at `SPEC.md:290`
supersedes only its exit-status observation.

No new error, verdict, state, or refusal was introduced, so no existing outcome vocabulary
receives a new default. No new invariant was introduced. The existing socket-path invariant
continues to be maintained before subprocess launch by
`assertCodexControlSocketPath` (`trident/codex-auth.ts:99-102`), independently of whether
Codex itself remains operational.

### Mutation table

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| None added | Not applicable: the measured current behavior made the proposed wrapper guard unnecessary, and there is no production daemon caller | Not applicable | Not applicable |

No mutation was performed because this change adds no guard. The existing bidirectional
socket guard is already mutation-recorded by #637; this change neither weakens nor replaces
it.

### Verification

- `codex --version`: `codex-cli 0.154.0`.
- Direct no-pipe measurements: 107-byte connect failure exit 1; 108-byte `SUN_LEN`
  refusal exit 1; ordinary missing socket exit 1.
- `bun test trident/codex-auth.test.ts`: 17 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh`: 51 configurations checked, all pass.
- `bash scripts/ci/lint.sh`: all lint sub-gates pass.
- `bash scripts/ci/leak-gate.sh --tree .`: zero findings from the rules that ran;
  incomplete because the local owner-specific denylist was unavailable. This is not
  recorded as a clean leak-gate result.

### Deliberately not changed

No feature flag, fallback, daemon wrapper, output parser, or dual path was added. Historical
as-built records were not rewritten. The 107-byte constant and its byte-count guard remain
unchanged. The existing `codex exec` wrapper outcomes remain unchanged because they concern
a separate CLI surface and already fail closed on non-zero status.
