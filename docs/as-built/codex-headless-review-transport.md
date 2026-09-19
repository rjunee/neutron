## 2026-09-19 — Route configured Codex review seats through a bounded review transport

The configured Codex peer reached the headless runner, whose supported roles
were only build and fix. The consuming build therefore stopped at review with
the required peer unavailable. Review and synthesis now use a separate transport;
the build wrapper and its key-value build trailer remain the build/fix path
(`runtime/workers/codex-headless.ts:116`, `:132`). This implements the placement
rule in the locked pivot plan §3.2 and the one-shot/thread-reuse decision in §3.3,
while retaining required-seat and missing-synthesis stops G057–G060.

Open supplies verdict and project-review schemas and host validators
(`open/wiring/project-build.ts:346`). The review process receives the brief on
stdin, an explicit model and requested effort, process cwd, read-only sandbox,
never-approval policy, and a structured-output schema. Its selected account home
is retained; the transport reads subscription credentials there and does not
materialize credentials elsewhere. GitHub and Codex API-key override variables
are scrubbed from child environments (`runtime/workers/codex-review.ts:17`, `:63`).

The CLI writes a candidate response to a host-chosen `-o` path. The structured
response has one `envelope` field so completed and blocked trailers can remain
distinct five-field objects inside a schema with an object root. The host checks
the exact run, step, schema, envelope fields and domain payload independently
(`runtime/workers/codex-review.ts:76`). Only exit zero plus observed thread and
completed-turn events can promote it to an atomic durable receipt (`:170`,
`:187`). Restart reads that receipt without replaying the step; malformed output,
missing completion and nonzero-after-output cannot be laundered into approval.
Usage comes from turn telemetry; the reported model remains unknown because the
event stream does not attest it. Cancellation and wall expiry terminate the
process group, escalating TERM to KILL.

Each recurring cross-provider seat stores its observed thread under run, project,
cwd, seat, model and selected-account identity. Later rounds, including a rebuilt
source, pass the stored id to `exec resume`; seats never share a thread. In-source
overlap queues under the configured wall setting, while another source's lock
fails closed (`trident/project-review-source.ts:69`). An uncertain dispatch keeps
its ownership lock: automatic lock recovery is deliberately not claimed.

Verification: the focused runner/source tests and the entire consuming
`open/__tests__/project-build-e2e.test.ts` surface pass together (125 tests).
The consuming fixture enables the real production Codex runner and substitutes
only the CLI process's model answer: the valid peer reaches merge and a wrong-run
envelope blocks it. Both root and Trident TypeScript checks pass. Four executable
mutations were restored after producing expected failures: removing review role
support blocks the consuming merge; weakening read-only to workspace-write fails
the argv guard; bypassing the run-id comparison makes the wrong-run consuming
case merge and fail its guard; accepting writable review requests fails the
grant-refusal test. The disabled-peer/default build remains a passing control.

Limits: these are offline executable and consuming tests, not a live provider or
deployment acceptance run. The broader thread-continuity spec item remains open:
live nonce-recall acceptance and a dedicated typed cross-process thread-conflict
outcome are not claimed. Conflicts currently reach the review infrastructure stop
with a named ownership error. This change does not replace the Codex build/fix
wrapper's thread behavior or implement other-provider headless transports.
