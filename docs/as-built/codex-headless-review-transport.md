## 2026-09-19 — Route configured Codex review seats through a bounded review transport

The configured Codex peer reached the headless runner, whose supported roles
were only build and fix. The consuming build therefore stopped at review with
the required peer unavailable. Review and synthesis now use a separate transport;
the build wrapper and its key-value build trailer remain the build/fix path
(`runtime/workers/codex-headless.ts:120`, `:136`). This implements the placement
rule in the locked pivot plan §3.2 and the one-shot/thread-reuse decision in §3.3,
while retaining required-seat and missing-synthesis stops G057–G060.

Open supplies verdict and project-review schemas and host validators
(`open/wiring/project-build.ts:346`). The review process receives the brief on
stdin, an explicit model, process cwd, read-only sandbox and a structured-output
schema. CLI review effort remains inert as specified by
`trident/phase-models.ts:245`; work needing an approval decision is refused at
the request boundary, and no approval-routing arguments are built, as required
by the thread-continuity spec item's no-escalation criterion. Its selected account home
is retained; the transport reads subscription credentials there and does not
materialize credentials elsewhere. GitHub and Codex API-key override variables
are scrubbed from child environments (`runtime/workers/codex-review.ts:18`, `:28`).

Admission verifies subscription credential shape, including rejecting mixed
OAuth/API-key bundles, before any Codex process is started, including version,
login and help probes (`runtime/workers/codex-headless.ts:110`). Dispatch rechecks
the same predicate. The executable fixtures record every invocation, and verify
zero invocations for invalid account files with a clean-OAuth spawning control.
The startup probe checks the exec/resume help surfaces separately
from configuration: a strict invocation ignores user config and places a bogus
sentinel after the sole relied-on key, `sandbox_mode`. It must fail naming the
sentinel, so a rejected real key or silently accepted unknown key cannot pass
(`runtime/workers/codex-review.ts:59`). Host construction preflights every enabled
review or synthesis route that resolves to a provider-matching transport; a present
transport's stable capability or credential refusal therefore stops before
plan/build worker turns (`trident/project-review-source.ts:55`). An absent or
provider-mismatched transport retains the panel gate's fail-closed behavior: it is
recorded as unavailable when review dispatch reaches that seat and cannot approve.
Disabled peers remain optional.

The CLI writes a candidate response to a host-chosen `-o` path. The structured
response has one `envelope` field so completed and blocked trailers can remain
distinct five-field objects inside a schema with an object root. The host checks
the exact run, step, schema, envelope fields and domain payload independently
(`runtime/workers/codex-review.ts:92`). Only exit zero plus observed thread and
completed-turn events can promote it to an atomic durable receipt (`:185`,
`:202`). Restart reads that receipt without replaying the step; malformed output,
missing completion and nonzero-after-output cannot be laundered into approval.
Usage comes from turn telemetry; the reported model remains unknown because the
event stream does not attest it. Cancellation and wall expiry terminate the
process group, escalating TERM to KILL.

Each recurring cross-provider seat stores its observed thread under run, project,
cwd, seat, model and selected-account identity. Later rounds, including a rebuilt
source, pass the stored id to `exec resume`; seats never share a thread. In-source
overlap queues under the configured wall setting, while another source's lock
fails closed (`trident/project-review-source.ts:77`). An uncertain dispatch keeps
its ownership lock: automatic lock recovery is deliberately not claimed.

Verification: the focused runner/source/host/production-boot tests and the entire
consuming `open/__tests__/project-build-e2e.test.ts` surface pass (162 tests).
The consuming fixture enables the real production Codex runner and substitutes
only the CLI process's model answer: the valid peer reaches merge and a wrong-run
envelope blocks it. Invalid credentials refuse before any plan, build or model call.
A missing required runner permits construction but is observed as unavailable at
review, before synthesis, fix or merge; the consuming control leaves the PR open and
the base branch unchanged. Both root and Trident TypeScript checks pass.
Eleven executable
mutations were restored after producing expected failures: removing review role
support blocks the consuming merge; weakening read-only to workspace-write fails
the argv guard; bypassing the run-id comparison makes the wrong-run consuming
case merge and fail its guard; accepting writable review requests fails the
grant-refusal test. The new probe/admission mutations also fail: putting the
sentinel first, accepting any nonzero probe without its sentinel diagnosis,
accepting a mixed OAuth/API-key account, bypassing admission preflight, and
preflighting deliberately disabled peers. The disabled-peer/default build remains
a passing control. Bypassing the credential gate before startup probes fails both
the executable and consuming zero-invocation guards while clean OAuth passes;
over-applying that gate to valid accounts fails the OAuth control while mixed
credentials remain refused. A no-model-call probe against the installed CLI also rejected
the sentinel with exit 1 and named that exact unknown key.

Limits: these are offline executable and consuming tests, not a live provider or
deployment acceptance run. The broader thread-continuity spec item remains open:
live nonce-recall acceptance, persisted CLI-version evidence and a dedicated typed
cross-process thread-conflict outcome are not claimed. Conflicts currently reach the review infrastructure stop
with a named ownership error. This change does not replace the Codex build/fix
wrapper's thread behavior or implement other-provider headless transports.
