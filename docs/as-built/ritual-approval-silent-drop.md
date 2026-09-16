## 2026-09-16 — a ritual approval prompt that fails to render now says so

`sweepPendingApprovals` in `reminders/ritual-registration.ts` re-raises every pending
ritual grant once a day. The per-row renderer it hands to `reraisePending` ended in
`catch { return null }`: a throw anywhere in the render — a malformed `args_json`, a
definition whose helper fails, a bad cadence — was discarded and turned into "no
prompt for this row". The outer catch one line below logs with the row id; the inner
one logged nothing.

What `null` actually does is worse than a skip. `reraisePending` treats a null render
as "Original approval content is no longer available" and **expires the grant** with
that reason (`tools/approval.ts`, `reraisePending`). So a render throw did not merely
drop one reminder — it permanently expired the approval and recorded a cause that
was not true. The owner never saw the prompt, and nothing anywhere said why; an
approval that never appears is indistinguishable from one that was never due.

The change is one line where the silence was: the inner catch binds the error and
logs `ritual approval render failed id=<row> ritual=<id>: <message>`, in the shape of
the outer catch beside it. It still returns `null`. The property that one bad row
cannot suppress every other ritual's prompt was the reason the catch existed and it
survives unchanged; the expiry semantics are not this change's to alter.

Measured on `reminders/ritual-registration.test.ts`, whose harness now accepts an
optional `log` sink:

- A batch of two grants with one row's `args_json` corrupted to `{not json` — the
  card's own example, and the realistic one, since `reraisePending` tolerates the bad
  column for its bookkeeping and still calls render, whose `JSON.parse` of the same
  column is what throws. The bad row still expires; exactly one log line names its
  row id, `ritual=daily-digest`, and the JSON cause.
- Positive control in the same test: the healthy row still emits, and its body,
  options and metadata are byte-identical to what that row emitted at proposal, with
  `idempotency_key` `ritual-reminder:<id>:1` — so "log everything and emit nothing"
  cannot pass.
- Mutation: deleting the new `log(...)` call (line 784 of
  `reminders/ritual-registration.ts`) compiles, runs, and reddens exactly that test —
  42 pass / 1 fail; with the line present, 43 / 0.
- `tsc --noEmit -p reminders/tsconfig.json`: 3 errors, all pre-existing in
  `cores/sdk/manifest.ts`, identical to the `origin/main` baseline.

Every other swallowed-cause site in the repository is out of scope here and tracked
separately.
