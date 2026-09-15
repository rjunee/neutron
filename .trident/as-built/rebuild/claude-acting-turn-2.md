## Claude acting turn — 2026-09-15

### Built and decisions

`createClaudeActingTurn` binds the existing project session and its host-owned
launch-grant observation (`runtime/workers/claude-acting-turn.ts:21`). It retains
that child and copies grants; constructing the binding from the actual launch is
the host caller's responsibility, not a worker assertion. Each invocation checks
the binding before taking the session mutex (`runtime/workers/claude-acting-turn.ts:27`).
The host must construct a new binding for a replacement session.

Submission uses that child's acknowledged `submitLine`, with JSON escaping the
multiline dispatch spec (`runtime/workers/claude-acting-turn.ts:49`). The existing
HerdrHost checks terminal state inside its queue and awaits text then Enter
(`runtime/adapters/claude-code/persistent/herdr-host.ts:651`). Its default RPC
uses `herdrCall` per call (`runtime/adapters/claude-code/persistent/herdr-host.ts:217`,
`runtime/adapters/claude-code/persistent/herdr-client.ts:572`). No second transport
was added. The scripted production-host test asserts the existing pane and order
(`runtime/workers/claude-acting-turn.test.ts:159`).

The trailer file is the end observation (`runtime/workers/claude-acting-turn.ts:52`).
Budget expiry without it is explicitly unknown, including a dead child that never
writes it: the cost is the full host budget instead of fast failure
(`runtime/workers/claude-acting-turn.ts:36`, `runtime/workers/claude-acting-turn.ts:69`).
The existing decoder still validates the result (`runtime/workers/project-runners.ts:58`).
Dispatch/read uncertainty throws; the original reservation prevents replay
(`runtime/workers/claude-in-repl.ts:38`, `runtime/workers/claude-acting-turn.test.ts:143`).
The host timer and post-acquisition stopped-signal check maintain the bounded wait
without requiring the worker to cooperate (`runtime/workers/claude-acting-turn.ts:39`,
`runtime/workers/claude-acting-turn.ts:46`). A restored test caught an early timer
settlement allowing late dispatch; the stopped-signal check fixes it without
changing the assertion (`runtime/workers/claude-acting-turn.test.ts:113`).

### Request fields and outcome vocabulary

Enumerated from `BoundedWorkRequest` (`runtime/bounded-work.ts:61`):

- Verify: tools, writable, network against host grants; cwd and non-null thread.id
  against the bound session (`runtime/workers/claude-acting-turn.ts:29`). Lesser
  grants are accepted. Check project/topic/provider separately. Wall budget is
  bounded by both request and host limits (`runtime/workers/claude-acting-turn.ts:36`).
- Pass: model_id through the existing worker's Agent arguments/model_preference,
  and effort in dispatch data (`runtime/workers/claude-in-repl.ts:55`,
  `runtime/workers/claude-acting-turn.ts:49`). The existing request envelope passes
  role, run_id, step_id, brief, result, thread, budget and needs_approval_decision
  (`runtime/workers/claude-in-repl.ts:59`). Run identity/reservation and trailer
  schema validation remain host mechanisms (`runtime/workers/project-runners.ts:112`,
  `runtime/workers/claude-in-repl.ts:38`, `runtime/workers/project-runners.ts:50`).
- Findings for the next change: forwarding effort/model data does not switch live
  launch options; this factory does not attest which model/effort the harness
  actually used. Brief integrity and suppression of interactive approval are not
  enforced here. Nor can `submitLine` cancel an already queued submission: its
  interface accepts only a command (`runtime/adapters/claude-code/persistent/pty-host.ts:191`).
  The complete request is forwarded, but forwarding these fields is not verification.

Non-Claude providers are refused by name (`runtime/workers/claude-acting-turn.ts:27`).
Tests enumerate `PROVIDERS` with a Claude success control
(`runtime/workers/claude-acting-turn.test.ts:36`, `runtime/workers/claude-acting-turn.test.ts:45`).
The outcome joins existing `refused/capability-unsupported`, propagated at
`runtime/workers/project-runners.ts:132`; the build switch stops blocked by default
for every refusal (`trident/build-run.ts:297`). Unknown stops unknown there (:295).

### Validation and mutations

Final targeted tests: **40 passed, 0 failed** (21 new, 19 existing).
`bun test runtime/workers/claude-acting-turn.test.ts runtime/workers/project-runners.test.ts`.
`bunx tsc -p runtime/tsconfig.json --noEmit`: **passed**. No broader suite was run.

Each row printed its landed line, passed `bunx tsc -p runtime/tsconfig.json --noEmit`,
then failed the new test file with an incorrect outcome/assertion. Restoring it
passed that file. The table enumerates all 18 executed mutations from their output;
these are runtime failures, not compiler failures.

| Guard | Landed line | Printed mutation | Mutated → restored |
| --- | --- | --- | --- |
| provider | `runtime/workers/claude-acting-turn.ts:27` | ``if (false) return refuse(`Claude acting turn refuses provider ${conversation.provider}.`)`` | RED → GREEN |
| project | `runtime/workers/claude-acting-turn.ts:28` | ``if (false \|\| conversation.topic_id !== topic_id) return refuse('Project conversation does not match the bound Claude session.')`` | RED → GREEN |
| topic | `runtime/workers/claude-acting-turn.ts:28` | ``if (conversation.project_id !== project_id \|\| false) return refuse('Project conversation does not match the bound Claude session.')`` | RED → GREEN |
| thread | `runtime/workers/claude-acting-turn.ts:29` | ``if (false) return refuse('Requested thread does not match the project Claude session.')`` | RED → GREEN |
| cwd | `runtime/workers/claude-acting-turn.ts:30` | ``if (false) return refuse('Requested cwd does not match the project Claude session.')`` | RED → GREEN |
| tools | `runtime/workers/claude-acting-turn.ts:31` | ``if (false) return refuse(`Requested tools ${request.tools} unavailable in Claude session.`)`` | RED → GREEN |
| writable | `runtime/workers/claude-acting-turn.ts:32` | ``if (false) return refuse('Requested writable access unavailable in Claude session.')`` | RED → GREEN |
| network | `runtime/workers/claude-acting-turn.ts:33` | ``if (false) return refuse('Requested network access unavailable in Claude session.')`` | RED → GREEN |
| acknowledged operation | `runtime/workers/claude-acting-turn.ts:34` | ``if (false) return refuse('Claude session lacks acknowledged submitLine.')`` | RED → GREEN |
| pre-acquire deadline | `runtime/workers/claude-acting-turn.ts:66` | ``if (false) return unknown()`` | RED → GREEN |
| post-acquire deadline | `runtime/workers/claude-acting-turn.ts:46` | ``if (false) return unknown()`` | RED → GREEN |
| trailer file | `runtime/workers/claude-acting-turn.ts:53` | ``if (true) return { kind: 'turn-ended' as const }`` | RED → GREEN |
| read errors | `runtime/workers/claude-acting-turn.ts:56` | ``if (false) throw error`` | RED → GREEN |
| budget outcome | `runtime/workers/claude-acting-turn.ts:40` | ``const unknown = () => ({ kind: 'turn-ended' as const, detail: 'Claude trailer not observed before cancellation or host budget expiry.' })`` | RED → GREEN |
| forward effort | `runtime/workers/claude-acting-turn.ts:49` | ``JSON.stringify({ ...spec })`` | RED → GREEN |
| refusal propagation | `runtime/workers/project-runners.ts:133` | ``refusal = undefined`` | RED → GREEN |
| stopped signal | `runtime/workers/claude-acting-turn.ts:39` | ``const expired = () => Date.now() >= deadline`` | RED → GREEN |
| lesser tool grants | `runtime/workers/claude-acting-turn.ts:31` | ``if (toolRank[request.tools] !== toolRank[grants.tools]) return refuse(`Requested tools ${request.tools} unavailable in Claude session.`)`` | RED → GREEN |

### Deliberate scope

Kept host construction/injection explicit; no pool discovery, new conversation,
launch reconfiguration, provider fallback, retry, or gateway wiring was added.
No live REPL was available. To prove the live half in the host process, provide a
host-owned fixture module exporting the real binding and one reserved input, then
run the following probe in that host's Bun environment:

```sh
bun -e 'const { binding, input } = await import(process.argv[1]); const { createClaudeActingTurn } = await import("./runtime/workers/claude-acting-turn.ts"); const outcome = await createClaudeActingTurn(binding)(input); if (outcome.kind !== "turn-ended") throw new Error(JSON.stringify(outcome));' ./host-acting-fixture.ts
```

The fixture must use the project's actual session/mutex and measured launch grants;
its prompt must request the uniquely identified trailer, which the host then
validates using its registered decoder. This command was not run here.

The two prior record paths in the brief could not be opened in the build worktree.
Working-tree enumeration `rg --files --hidden .trident/as-built | rg 'acting-turn|fix-927-fix'`
found the positive-control `fix-927-fix.md` before this record was written.
Proceeded under both explicit rulings, without a claim about remote contents.
This shard location follows the lane brief's explicit override of the general
tracking standard. No product decision was changed.
