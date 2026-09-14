## 2026-09-14 — routing 404 is not a missing ref

### What changed

The host-deploy remote reader's 404 guard at
`open/host-deploy-runtime.ts:125` now returns `null` only when the parsed
JSON error is exactly `does not know the ref`; that response is the existing
missing-ref contract exercised at
`open/__tests__/host-deploy-runtime.test.ts:131-135`. A routing response with a
different error and a body-less ambiguous 404 both throw, as exercised at
`open/__tests__/host-deploy-runtime.test.ts:137-147`.

The thrown outcome joins the existing host-deploy request vocabulary: the
service catches remote-reader exceptions at `open/host-deploy.ts:824-831` and
returns `status: 'refused'` with the machinery failure detail. The verified
missing-ref `null` continues through the distinct refusal at
`open/host-deploy.ts:833-837`.

### Decisions

The discriminator is both the HTTP status and the parsed `error` value, not
status alone. A different or unreadable 404 body is insufficient evidence that
the route executed, so it takes the existing thrown-failure path. This makes an
ambiguous response fail closed without adding a new public result value or a
parallel implementation.

### Mutation proof

| Guard | Mutation | Red | Restored |
|---|---|---|---|
| `open/host-deploy-runtime.ts:125` requires the explicit missing-ref detail | Replaced it with unconditional `status === 404` and printed the landed line plus diff before execution | `bun test open/__tests__/host-deploy-runtime.test.ts` failed the routing-404 and ambiguous-404 tests (17 pass, 2 fail) | The same command passed (19 pass, 0 fail) |

### Verification

- `bun test open/__tests__/host-deploy-runtime.test.ts` — 19 pass, 0 fail.
- `bash scripts/ci/lint.sh` — passed every gate.
- `bash scripts/ci/typecheck-all.sh` — `open/tsconfig.json` passed. The complete
  51-config matrix remains red in files outside this change:
  `gateway/transcription/__tests__/whisper-install.test.ts:186`,
  `onboarding/history-import/__tests__/zip-writer.ts:10`, and
  `logger/__tests__/fire-and-forget.test.ts:301`, plus an app dependency type
  directory error; the aggregate root config repeats the same source errors.

### Deliberately not changed

No service result taxonomy, endpoint routing, deploy execution behavior, spec
decision, or documentation outside this required record changed. The task was
limited to the remote host-deploy response reader and its focused tests. The
full test suite was not run, as directed.
