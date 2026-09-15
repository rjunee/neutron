## 2026-09-15 — Pi bounded subagents through the project REPL (#938)

### Change and boundary

Added `piInReplRunner`, the third bounded-worker seam, with provider `pi` and
in-repl-only admission (`runtime/workers/pi-in-repl.ts:35`). Its host callback
resumes the existing project session and must bind the distinct user-scope extension
agent to the request's exact model, effort and enforced grants before prompting
(`runtime/workers/pi-in-repl.ts:14`). The complete request reaches that callback
at `runtime/workers/pi-in-repl.ts:88`; it is not reduced to prompt instructions.
The extension gets its documented agent/task/cwd arguments at
`runtime/workers/pi-in-repl.ts:66`. The agent name includes the run/step hash
(`runtime/workers/pi-in-repl.ts:67`), so different steps cannot race by overwriting
one shared definition. The host receives this derived name at `:88`. Pi accepts a definition name rather than Codex's
model/effort spawn arguments, so copying the Codex prompt would be wrong.

Exclusive filesystem creation reserves run/step before compose, independent of
the model remaining alive (`runtime/workers/pi-in-repl.ts:52`). Matching retries
observe the prior trailer, while different identities return unknown
(`runtime/workers/pi-in-repl.ts:59`). The reservation persists across runner and
process replacement; this is not a claim about power-loss fsync durability.
The decoder sees only file bytes (`runtime/workers/pi-in-repl.ts:98`). Cancellation
and deadline bounds observe uncertainty rather than asserting child death
(`runtime/workers/pi-in-repl.ts:89`, `:106`). Liveness defaults and exceptions both
return unknown (`runtime/workers/pi-in-repl.ts:115`).

The existing outcome vocabulary is `BoundedWorkOutcome` and `RefusalReason`
(`runtime/bounded-work.ts:98`, `:106`). This runner uses their existing unknown,
placement-unavailable and capability-unsupported values. The build loop stops
unknown on unknown and maps every refusal to blocked by default
(`trident/build-run.ts:257`, `:259`). Child-thread resume is refused because the
measured extension creates ephemeral children (`runtime/workers/pi-in-repl.ts:46`).
This does not prevent the parent project conversation from continuing.

### Measurement and issue citation corrections

`pi --version` returned 0.85.1. The filed issue's vocabulary/storage observations
are stale: `runtime/provider.ts:2` includes pi and
`migrations/0147_project_provider_vocabulary.sql:25` admits it. The worker
exemplars were inspected against reservation/trailer properties before copying:
`runtime/workers/claude-in-repl.ts:43`, `:85` and
`runtime/workers/codex-in-repl.ts:46`, `:88`.

Installed-package citations below are relative to
`@earendil-works/pi-coding-agent`, not repository paths:

- `docs/rpc.md:22` defines JSONL commands/responses/events; `:76` distinguishes
  prompt acceptance from completion; `:5` names the SDK alternative.
- `docs/usage.md:309` explicitly excludes built-in subagents. The documented
  extension registers `subagent` at `examples/extensions/subagent/index.ts:472`.
- `examples/extensions/subagent/index.ts:300` starts ephemeral sessions;
  `:302` chooses definition model or dispatch model; `:307` only adds --tools for
  a nonempty list. A toolless request cannot safely be represented by an empty
  definition list. `:346` starts the child; `:403` maps signal-only close to zero.
- `docs/sessions.md:14` documents explicit session selection. SDK model controls
  are at `docs/sdk.md:86`; CLI tool selection is at `docs/usage.md:212`.

Reproduction: `python3 scripts/probes/pi-in-repl.py` (Pi installed; Linux).
The probe isolates its agent directory (`scripts/probes/pi-in-repl.py:62`), loads
the actual installed extension (`:69`), and sends extension commands over actual
RPC (`:99`). Measured exact active/configured lists: read+subagent, empty under
--no-tools, read under subagent exclusion (`:94`). Those positive controls
establish tool selection; they do not establish OS confinement. The initial
assertion that getAllTools would still list read/subagent under --no-tools was
wrong: both lists were empty. It was replaced by an exact equality assertion
against each CLI-selected surface, including the positive control (`:103`).

Across process restarts, the seeded session ID and custom conversation marker
survived (`scripts/probes/pi-in-repl.py:105`, `:113`, `:143`). The controller killed
the actual extension child (`:126`); the tool reported exitCode 0, messages 0
(`:138`). A zero exit report therefore cannot validate bounded success. The
measurement does not claim actual LLM history use, tool selection by a model,
trailer compliance by a model, or cache behavior.

### Decisions and scope

A dated clarification in `SPEC.md:294` records Pi's extension-process boundary;
older Decisions Log entries remain immutable. Acceptance is in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:356`. The plan's old
no-process assumption and contract comments were corrected together
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:101`,
`runtime/bounded-work.ts:16`, `:35`).

Phrase sweep used `rg -n 'no new process|warm cache, shared MCP|pre-cutover harnesses'
--glob '*.md' --glob '*.ts' .`. Positive control: the new pre-cutover qualification
at plan line 102. Remaining warm-cache hits: immutable historical decision at
`SPEC.md:533`; dated Codex/Claude cost discussion in
`docs/plans/2026-09-14-trident-rebuild-design-fable.md:262`. They stay as historical
rationale, not Pi measurements. This is a content search of this checkout, not a
claim about a freshly fetched remote ref; this lane has no network.

Deliberately not built: a project-session adapter, a child sandbox, extension
installation, a Pi headless runner, provider migration, or live-model claims.
The specified deliverable is the same host-injected worker seam as the two
exemplars; host obligations are explicit at `runtime/workers/pi-in-repl.ts:17`.
The sample extension is not advertised as a confinement boundary. Toolless and
read-only work require a host-owned trailer writer outside the child grants.

With credentials and a host-configured user-scope agent, the following live
measurement can exercise model selection of the extension and trailer writing.
Set PI_PROJECT_SESSION to the existing session file, PI_SUBAGENT_EXTENSION to the
installed extension entrypoint, PI_MODEL_PROVIDER/PI_MODEL_ID to the chosen model,
and PI_MEASUREMENT_PROMPT to the dispatch prompt captured at the host callback
(`runtime/workers/pi-in-repl.ts:83`). Run in the requested task cwd:

```sh
pi --session "$PI_PROJECT_SESSION" --provider "$PI_MODEL_PROVIDER" \
  --model "$PI_MODEL_ID" -e "$PI_SUBAGENT_EXTENSION" --tools subagent \
  -p "$PI_MEASUREMENT_PROMPT"
```

Then validate the requested trailer with the host decoder and remeasure output
and model metadata. CLI exit/prose is insufficient. This command was not run;
provider credentials are not configured. It does not test a deployed host sandbox.

### Mutation evidence

Every row was run against the named test filter using
`bun test runtime/workers/pi-in-repl.test.ts -t '<filter>'`, then restored and run
again. The mutation controller printed the changed source line before execution,
required an actual failing test, and restored the source in a finally block.
All 23 mutations went RED, all restored runs GREEN. The rows enumerate the
controller's mutation list, not a claim of exhaustive mutation coverage.
Line numbers below refer to `runtime/workers/pi-in-repl.ts`.

| Guard/behavior | Mutation printed at source line | Test filter | Mutated / restored |
| --- | --- | --- | --- |
| placement | `36: const supports: WorkerRunner['supports'] = (_role, placement) => true \| 37: ? { ok: true } \| 55: let dispatch = true` | headless placement | RED / GREEN |
| run placement guard | `45: // placement guard removed` | headless placement | RED / GREEN |
| child continuity | `46: // thread guard removed` | ephemeral extension | RED / GREEN |
| pre-reservation cancellation | `48: // initial guard removed` | cancellation before dispatch | RED / GREEN |
| reservation before acting | `57: await Promise.resolve()` | dispatches one explicitly | RED / GREEN |
| initial budget | `48: if (signal.aborted) return unseen('Cancelled or out of time before dispatch.')` | an exhausted budget | RED / GREEN |
| exclusive reservation | `57: await writeFile(reservation, identity, { flag: 'w' })` | concurrent runner | RED / GREEN |
| reservation identity | `59: if (false) {` | different request cannot | RED / GREEN |
| no replay | `55: let dispatch = true \| 62: dispatch = true` | retry after runner replacement | RED / GREEN |
| post-reservation cancellation | `65: // post-reservation guard removed` | cancellation while reserving | RED / GREEN |
| host model | `82: model_preference: options.spec.model_preference,` | each distinct dispatch | RED / GREEN |
| host request | `88: options.composeActingTurn(options.topic_id, spec, { timeout_ms: Math.max(1, deadline - Date.now()), request: undefined, subagent: args.agent }),` | dispatches one explicitly | RED / GREEN |
| distinct definitions | `67: agent: options.subagent,` | the same step in another run | RED / GREEN |
| user-scope agent | `68: agentScope: 'project',` | dispatches one explicitly | RED / GREEN |
| bounded dispatch | `89: new Promise(() => {}), // delay(Math.max(1, deadline - Date.now()), undefined, { signal: AbortSignal.any([signal, timer.signal]) })` | dispatch that never settles | RED / GREEN |
| cancellable dispatch | `89: delay(Math.max(1, deadline - Date.now()), undefined, { signal: timer.signal })` | cancellation interrupts | RED / GREEN |
| observation cancellation | `96: while (Date.now() < deadline) {` | cancellation during observation | RED / GREEN |
| file decoder | `98: return { kind: 'blocked', on: 'fabricated reply' }` | dispatches one explicitly | RED / GREEN |
| bad trailer | `100: if (false) {` | invalid trailer | RED / GREEN |
| missing trailer polling | `100: if (true) {` | waits for a trailer written | RED / GREEN |
| unknown dispatch | `110: return { kind: 'failed', class: 'infra', detail: 'claimed' }` | thrown dispatch | RED / GREEN |
| blind liveness | `115: return await options.probe?.(handle) ?? 'nothing'` | blind liveness | RED / GREEN |
| failed probe | `117: return 'nothing'` | blind liveness | RED / GREEN |

### Offline probe mutation controls

Each mutation below was printed at the cited line, made
`python3 scripts/probes/pi-in-repl.py` fail an assertion, and passed after
restoration. These test the measurement against missing capabilities, not a
modified installed Pi binary.

| Probe control | Mutation in scripts/probes/pi-in-repl.py | Mutated / restored |
| --- | --- | --- |
| Extension registration | Line 73: capture definition but remove pi.registerTool(definition) | RED / GREEN |
| Toolless selection | Line 95: replace --no-tools flags with an empty list | RED / GREEN |
| Excluded tool | Line 96: exclude missing-tool instead of subagent | RED / GREEN |
| Session selection | Line 97: use --no-session instead of the explicit session | RED / GREEN |

### Validation

- `bun test runtime/workers/pi-in-repl.test.ts`: 34 passed; guard mutations above.
- `bunx tsc --noEmit`: passed. This checks the root config, which includes runtime
  (`tsconfig.json:16`). Search `rg -n '"(typecheck|start)"' package.json`
  found the positive-control start script at `package.json:58` and no typecheck
  entry, so the underlying compiler command was used. It is not the all-config matrix.
- `bash scripts/ci/lint.sh`: passed all reported gates.
- `python3 scripts/probes/pi-in-repl.py`: passed the offline contract measurements.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings
  among executed rules; the private PII denylist was unavailable, so its file
  and message rules could not run. This is not a clean leak-gate result.
- Full test suite deliberately not run, per lane instruction.

This record is staged at the lane-requested path rather than docs/as-built;
the explicit task overrides the repository's usual shard location. Delivery is
a local branch commit only; the orchestrator owns publication and merge.
