## 2026-09-15 — Codex acting turn: hosted-session prerequisite missing

### Finding and evidence boundary

Finding-only delivery, as explicitly allowed by WIRE10. In the inspected build
worktree, the hosted conversational Codex path is headless, not a live project
REPL: gateway construction selects the Codex factory and starts its substrate
(`gateway/wiring/build-llm-call-substrate.ts:1415`, :1433), selection returns
`createCodexCliSubstrate` (`runtime/adapters/select-substrate.ts:179`), and each
start reaches `startCodexExec` (`runtime/adapters/codex-cli/index.ts:63`, :106).
That function builds `exec --json`, optionally adding a resume id, then spawns
with stdin ignored (`runtime/adapters/codex-cli/exec.ts:121`, :151). A saved
thread id resumes a subprocess; it does not expose an already-running REPL.

The apparent in-REPL path is a consumer of a required host callback
(`runtime/workers/codex-in-repl.ts:17`, :78). It places a
`collaboration.spawn_agent` instruction in prompt data (:73); this does not
establish a hosted session or availability of that tool. The gateway callback
with the same name starts its substrate and collects reply tokens
(`gateway/wiring/build-live-agent-turn.ts:1094`, :1110, :1115).

Search controls, run in this session against working-tree source, not a fetched
remote ref or a live deployment:

```sh
rg -n 'composeActingTurn|createProjectRunners|createClaudeActingTurn|createCodexActingTurn' --glob '*.ts' --glob '!*.test.ts' --glob '!**/__tests__/**' .
rg -n 'submitLine|acquireTurn' runtime/adapters/codex-cli runtime/adapters/claude-code/persistent/repl-session.ts runtime/adapters/claude-code/persistent/pty-host.ts --glob '*.ts' --glob '!*.test.ts' --glob '!**/__tests__/**'
```

The first enumerated matching callback/factory references, finding the Claude
factory positive control (`runtime/workers/claude-acting-turn.ts:21`) and the
gateway callback above, but no Codex acting factory. The second found neither
operation in the Codex adapter, with positive controls at
`runtime/adapters/claude-code/persistent/repl-session.ts:461` and
`runtime/adapters/claude-code/persistent/pty-host.ts:191`. The concrete Codex
handle instead exposes events, rejecting tool response, and cancellation
(`runtime/adapters/codex-cli/index.ts:128`). Claude's factory positively reaches
its persistent host (`runtime/adapters/claude-code/index.ts:655`).

### Required prerequisite and preserved contract

Before this acting turn can be implemented, a host must own the live Codex
project session, bind project/topic/provider/thread/cwd and observed launch
grants, expose serialized acknowledged submission into that same session, and
replace the binding when the session changes. These are the properties required
by the Claude exemplar (`runtime/workers/claude-acting-turn.ts:8`, :27, :44, :49).
The task explicitly excludes inventing that host in this lane.

The stipulated end observation remains trailer appearance within the host and
request wall budgets (`runtime/workers/claude-acting-turn.ts:36`, :52).
Acceptance, reply output and exit status are insufficient
(`runtime/workers/project-runners.ts:19`). No alternate signal was investigated.

Fields enumerated from `BoundedWorkRequest` (`runtime/bounded-work.ts:61`): the
existing worker forwards the entire request, including role, run/step identity,
model/effort, cwd, tools, writable, network, brief, result, thread, budget and
approval-decision field; it additionally supplies model/effort as child arguments
(`runtime/workers/codex-in-repl.ts:55`, :62). It reserves run/step before dispatch
(:41) and bounds waiting (:36, :78). Forwarding cannot verify live thread/cwd or
tool/write/network grants without the missing host binding. This lane therefore
adds neither field verification nor pass-through, and makes no model, effort,
brief-integrity or approval-suppression enforcement claim.

Non-Codex refusal is **not implemented or tested**: there is no deliverable live
Codex acting implementation. Its required future outcome belongs to existing
`refused/capability-unsupported` (`runtime/bounded-work.ts:107`, :113), propagated
by `runtime/workers/project-runners.ts:132`; the build switch stops blocked for
every refusal and preserves unknown separately (`trident/build-run.ts:295`).
No Claude substitution is proposed.

### Validation and mutation table

`bun test runtime/workers/project-runners.test.ts`: **19 passed, 0 failed**.
`bunx tsc -p runtime/tsconfig.json --noEmit`: **passed**. These validate the base
contract, not live hosting: the test callback writes its own trailer
(`runtime/workers/project-runners.test.ts:31`). No new test file was warranted
for a finding-only delivery; no broader suite was run.

| Guard | Mutation / landed line | RED → restored GREEN |
| --- | --- | --- |
| None added | Not applicable: documentation-only finding | Not run; no executable change to mutate |

### Deliberate scope

No runtime code, tests, composition, old paths or product decisions changed.
No session type, fallback, spawn or retry added. The missing hosted-session
prerequisite is the stopping condition from the task brief. This record uses
the lane's explicitly required shard location instead of the general tracking
location; no spec decision was revised. Local commit only; no push, PR or merge.
