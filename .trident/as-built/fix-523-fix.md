## Issue 523 — retire the dead scheduled digest onto the email poller

### What changed

The email pipeline now exposes a best-effort callback for each newly persisted message at `cores/free/email/src/pipeline/poller.ts:102-104` and invokes it only after the durable row is written at `cores/free/email/src/pipeline/poller.ts:838-851` and `cores/free/email/src/pipeline/poller.ts:876-889`. Gateway wiring adapts that callback to the existing scribe payload and source vocabulary at `gateway/cores/email-pipeline-wiring.ts:131-135`. Production supplies the existing scribe binding at `open/composer.ts:6691-6704`.

The old email scheduler, its unit test, and its scheduler-only gateway wiring were deleted. The public email barrel and package export no longer expose that scheduler. The Cores fan-out mount now starts only the Calendar scheduler and exposes its shared callback to the email poller at `gateway/cores/mount-cores-scribe-fan-out.ts:160-176` and `gateway/cores/mount-cores-scribe-fan-out.ts:245-275`.

The on-demand tool remains registered through the capability guard at `cores/free/email/src/tools.ts:318-324`. The focused tools suite exercises it and remained green.

### Decisions

The poller's existing durable email row is the continuous idempotency mechanism: `store.hasEmail` excludes handled rows before processing at `cores/free/email/src/pipeline/poller.ts:941-953`. This mechanism does not depend on scribe succeeding; the row is persisted before the fire-and-forget observer runs at `cores/free/email/src/pipeline/poller.ts:838-851`. No new error, verdict, state, or refusal was introduced, so no outcome vocabulary needed extension.

The old notification kind remains only for routing previously emitted payloads; no second digest producer remains. Historical research and archived as-built references were deliberately left unchanged because they describe the pre-cutover tree.

### Tests and mutation evidence

| Guard | Mutation | Red | Restored green |
|---|---|---|---|
| Pipeline handler adapts `on_message_processed` to `scribeFanOut` at `gateway/cores/email-pipeline-wiring.ts:131-135` | Replaced the adapter body with a parse-valid no-op at line 133 | `new mail rides the pipeline into scribe exactly once`: expected 1 fan-out, received 0 | Same focused test: 1 pass, 0 fail |

The focused five-file run completed with 52 passing tests and 0 failures: email poller, gateway poll wiring, fan-out mount, scribe Core-source behavior, and email tools. `bunx tsc --noEmit` reached the root deploy gate but reported three pre-existing errors in untouched files: `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`. The root package declares no `typecheck` or lint script in `package.json:10-15`.

### Deliberately not changed

The on-demand `email_triage` tool and old-notification deep-link routing remain. No feature flag, compatibility scheduler, second poller, or new outcome was added. The full suite was not run, per the bounded validation instruction.
