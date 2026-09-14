## 2026-09-14 — Triage scheduler tests drive start() through its clock seam (#678)

### What changed and why

The two whole-inbox regressions now inject the fixed 08:00 local instant into
`start()` and use that call as their only tick
(`cores/free/email/__tests__/triage-scheduler.test.ts:361`,
`cores/free/email/__tests__/triage-scheduler.test.ts:400`). Their result no longer
depends on which minute the runner enters the case. The assertions remain exact:
one unscoped inbox read and one inbox containing the ordinary message
(`cores/free/email/__tests__/triage-scheduler.test.ts:365-370`,
`cores/free/email/__tests__/triage-scheduler.test.ts:404`).

The seam follows the existing `DocStoreOptions.now` shape: an optional callback
whose omitted value uses the current clock (`gateway/http/doc-store.ts:363-370`,
`gateway/http/doc-store.ts:420-423`). Triage already exposes the same optional
callback and defaults it to `new Date()`
(`cores/free/email/src/triage-scheduler.ts:93-94`,
`cores/free/email/src/triage-scheduler.ts:101-107`); `start()` consumes that callback
at `cores/free/email/src/triage-scheduler.ts:171-185`. A new case fixes Bun's process
clock, omits the option, and asserts that `start()` fires at that current instant
(`cores/free/email/__tests__/triage-scheduler.test.ts:24-50`). This pins unchanged
production behavior without adding a wall-clock tolerance.

### Decisions and outcomes

The tests drive `start()` rather than retaining an explicit `tick()` after it.
That makes the injected clock the only route to the expected observation and makes
a bypass mutation capable of failing. No production code, timer behavior, error,
verdict, state, or refusal changed, so there is no new outcome to classify. The
existing scheduler fire/no-op behavior remains governed by `isFireTime` and the
per-day guard (`cores/free/email/src/triage-scheduler.ts:112-120`,
`cores/free/email/src/triage-scheduler.ts:202-205`).

### Mutation table

| Guard | Mutation and printed landing | Red | Restored green |
| --- | --- | --- | --- |
| `start()` clock seam | Replaced `nowFn()` with `new Date()` at `cores/free/email/src/triage-scheduler.ts:180`; the landed line was printed before execution. | Both target cases failed: the read count was 0 instead of 1 and the observed inbox list was empty instead of `[1]`. Three pre-existing seam cases also failed. | Focused file: 11 pass, 0 fail. |

### Verification

- `bun test cores/free/email/__tests__/triage-scheduler.test.ts` — 11 pass, 0 fail.
- `bunx tsc -p cores/free/email/tsconfig.json --noEmit` — pass.
- `bash scripts/ci/lint.sh` — pass.
- `bash scripts/ci/typecheck-all.sh` — all 51 TypeScript configurations pass.
- `bash scripts/ci/leak-gate.sh --tree .` — incomplete with zero findings from
  available rules; the private PII denylist and its message scan were unavailable.
- `bun run typecheck` is not defined in `package.json:57-63`; the documented matrix
  command at `CONTRIBUTING.md:79` was used.

### Deliberately not changed

No tolerance was widened, production scheduler code was not modified, and no
feature switch or alternate path was added. `SPEC.md` and spec items were not
changed because the product behavior and decisions are unchanged. The full test
suite was not run, per the lane instruction to run only the touched test file.

This record uses the lane-mandated staging location rather than `docs/as-built`.
