## 2026-09-15 — Codex bounded work inside the project REPL

### Change and boundaries

Added `codexInReplRunner` for `openai-codex`, accepting `in-repl` and refusing
`headless` with `placement-unavailable` (`runtime/workers/codex-in-repl.ts:26`).
It asks the host to resume the existing session and invoke
`collaboration.spawn_agent` once (`runtime/workers/codex-in-repl.ts:73`).
The host seam is explicitly an existing-session operation with multi-agent tools
and file access (`runtime/workers/codex-in-repl.ts:14`). Wiring remains a later lane.

Read the exemplar against each property before copying its structure:
placement refusal at `runtime/workers/claude-in-repl.ts:23`, exclusive creation
at :43, file decoding at :85, and uncertain observation at :93. This establishes
the local structure, not a measurement of Codex death semantics.

The new runner passes the requested model, optional effort, a fresh context,
and a stable hash-derived task name (`runtime/workers/codex-in-repl.ts:55`).
A fresh context permits the explicit overrides; the task gets the brief path,
cwd, limits and trailer instructions (`runtime/workers/codex-in-repl.ts:60`).
The child is instructed to publish a temporary file by rename. Only file bytes
reach the host decoder (`runtime/workers/codex-in-repl.ts:88`); prose is discarded.
The decoder owns identity/schema checking and measured metadata, as required by
its interface (`runtime/workers/codex-in-repl.ts:18`). Tests supply a decoder that
checks run, step and schema (`runtime/workers/codex-in-repl.test.ts:37`).

Exclusive filesystem creation continuously prevents a second runner invocation
from dispatching the same `(run_id, step_id)` while the host retains `state_dir`
(`runtime/workers/codex-in-repl.ts:41`). It does not depend on the child remaining
alive. The full request must match an existing reservation; partial writes,
changed requests and unreadable reservations conservatively yield unknown
(`runtime/workers/codex-in-repl.ts:48`). Reservations are retained after an
uncertain dispatch. Host reconciliation is required; no reservation cleanup or
automatic replay was added. Concurrent callers and runner replacement are tested
at `runtime/workers/codex-in-repl.test.ts:243` and :105. This is a dispatch-attempt
reservation, not proof that a model obeyed an exactly-once tool instruction.

No new outcome category: `unknown` and `refused` join the existing union at
`runtime/bounded-work.ts:97`. The existing host switch explicitly stops on
unknown, turns refusal into blocked, and only proceeds to independent measurement
for completed (`trident/build-run.ts:245`). Blind liveness uses the existing
unknown vocabulary (`runtime/bounded-work.ts:139`,
`runtime/workers/codex-in-repl.ts:104`).

### Mechanism evidence and its limits

The addendum supplied these external measurements, accepted as supplied rather
than rerun inside this sandbox:

```text
$ codex --version
codex-cli 0.154.0
$ codex debug prompt-input --enable multi_agent_v2 'x'
spawn_agent x 3
send_message x 2
followup_task x 2
multi_agent x 4
control: shell / apply_patch x 2
```

Actually ran the following positive-control search on the staged artifact:

```text
$ rg -o 'spawn_agent|task_name|TOML|FINAL_ANSWER' ../briefs/codex-subagent-surface.json
spawn_agent
FINAL_ANSWER
spawn_agent
spawn_agent
```

This search finds the known spawn references but neither `task_name` nor `TOML`
in this artifact. It does not establish whether the installed CLI requires a
configuration file. Structural inspection enumerated all five JSON records:

```python
import json
messages = json.load(open('../briefs/codex-subagent-surface.json'))
print('message records:', len(messages))
print('record types:', sorted({m['type'] for m in messages}))
for m in messages:
    for c in m['content']:
        text = c.get('text', '')
        if text.startswith('You are `/root`'):
            for line in text.splitlines():
                if any(term in line for term in ['MESSAGE | FINAL_ANSWER',
                    'same container', 'same current working directory',
                    'edits made', '4 available', 'fork_turns']):
                    print(line)
```

Output (the Python inspection above was run in this session):

```text
message records: 5
record types: ['message']
You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.
Message Type: MESSAGE | FINAL_ANSWER
- All agents have access to the same container and filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.
There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.
Full-history forks (`fork_turns` omitted or `"all"`) inherit the parent model and reasoning effort and do not accept overrides. Only set `model` or `reasoning_effort` when explicitly requested by the user, applicable `AGENTS.md` instructions, or skill instructions; when doing so, set `fork_turns` to `"none"` or a positive integer string.
```

The staged messages document shared files, parent MESSAGE / FINAL_ANSWER delivery,
and the context-override rule (`../briefs/codex-subagent-surface.json:37`). They
are not a tool-schema dump. Additional direct evidence is the active session's
exposed `collaboration.spawn_agent` tool schema: required `task_name` and
`message`, optional `fork_turns`, `model`, and `reasoning_effort`. The runner uses
those observed fields rather than inventing a TOML format. No definition file is
passed by this runner (`runtime/workers/codex-in-repl.ts:55`). Whether extra
installed configuration is required remains unmeasured by the staged artifact.

Shared filesystem visibility supports the trailer design, provided the host
allows the chosen path in the child sandbox. This session did not execute a live
child-file round trip. The fixture writes and renames a real file at
`runtime/workers/codex-in-repl.test.ts:45`; it verifies the runner's consumption,
not the installed CLI's sandbox. Prompted write/tool/network limits are not an
independent enforcement mechanism; the host must enforce them, as documented at
`runtime/workers/codex-in-repl.ts:14`.

The staged text does not establish how death differs from normal completion or
acknowledges cancellation. Thus dispatch exceptions, expiry, cancellation,
unreadable/invalid files and missing trailers return unknown
(`runtime/workers/codex-in-repl.ts:90`, :96, :101, :115). Even a conversational
claim of death or completion is ignored (`runtime/workers/codex-in-repl.test.ts:280`).
The runner bounds observation; it does not claim to kill a child. A rejected spawn
or exhausted concurrency without a trailer is likewise unknown.

### Mutation evidence

For every row below, changed exactly the listed production line, ran
`bun test runtime/workers/codex-in-repl.test.ts --test-name-pattern '<pattern>'`,
restored the original source, and reran the same command. RED means exit 1;
restored GREEN means exit 0. The mutation harness printed each actual changed
line by comparing it to the original (not by searching for a matching value).

| Guard | Actual mutated line in runtime/workers/codex-in-repl.ts | Test name pattern | Mutated / restored |
| --- | --- | --- | --- |
| runtime placement refusal | `35: if (false) return { kind: 'refused', reason: supported.reason }` | headless placement | RED exit 1; restored GREEN exit 0 |
| dispatch timeout | `80: .then(() => new Promise<never>(() => {})),` | a dispatch that never settles | RED exit 1; restored GREEN exit 0 |
| key includes run | `41: const key = createHash('sha256').update(JSON.stringify([req.step_id])).digest('hex')` | same step in another run | RED exit 1; restored GREEN exit 0 |
| placement | `26: const supports: WorkerRunner['supports'] = (_role, placement) => placement !== 'in-repl'` | headless placement | RED exit 1; restored GREEN exit 0 |
| pre-dispatch cancellation | `37: if (false) return unseen('Cancelled or out of time before dispatch.')` | cancellation before dispatch | RED exit 1; restored GREEN exit 0 |
| post-reservation cancellation | `54: if (false) return unseen('Cancelled or out of time before dispatch.')` | cancellation while reserving | RED exit 1; restored GREEN exit 0 |
| atomic reservation | `46: await writeFile(reservation, identity, { flag: 'w' })` | retry after runner replacement | RED exit 1; restored GREEN exit 0 |
| request identity | `48: if (false) {` | a different request | RED exit 1; restored GREEN exit 0 |
| no redispatch | `51: dispatch = true` | a thrown dispatch | RED exit 1; restored GREEN exit 0 |
| file result | `88: return options.decodeTrailer(await readFile(req.brief.path, 'utf8'), req)` | dispatches one explicitly | RED exit 1; restored GREEN exit 0 |
| missing-file polling | `90: if ((error as NodeJS.ErrnoException).code === 'ENOENT') {` | waits for a trailer | RED exit 1; restored GREEN exit 0 |
| observation cancellation | `86: while (Date.now() < deadline) {` | cancellation during observation | RED exit 1; restored GREEN exit 0 |
| unknown outcome | `115: return { kind: 'failed', class: 'infra', detail }` | missing trailer is unknown | RED exit 1; restored GREEN exit 0 |
| blind liveness | `106: return await options.probe?.(handle) ?? 'nothing'` | blind liveness | RED exit 1; restored GREEN exit 0 |
| failed liveness probe | `108: return 'nothing'` | blind liveness | RED exit 1; restored GREEN exit 0 |

An initial timeout mutation replaced Promise.race with Promise.all and stayed
green: both reject when the timer rejects, so it could not disable the timeout.
The corrected mutation at :80 makes the timer stay pending; the existing
never-settling-dispatch fixture then fails at its test timeout. No test was
weakened. An ambiguous early replacement was rejected before writing, and an
initial diagnostic that matched the earlier `dispatch` initialization was
corrected to print the actual diff line :51; the table records the rerun.

### Validation and delivery

- `bun test runtime/workers/`: 78 pass, 0 fail, three files (the runner's directory).
- `bun run typecheck`: unavailable, reports `Script not found "typecheck"`.
  The scripts are enumerated at `package.json:57`; used tsc directly instead.
- `bunx --no-install tsc -p runtime/tsconfig.json --noEmit`: exit 0.
- `bunx --no-install tsc -p tsconfig.json --noEmit`: exit 0.
- `bash scripts/ci/lint.sh`: exit 0, all reported gates passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings
  from the rules that ran; `pii-denylist` and `pii-denylist-msg` could not run.
  The orchestrator must rerun with the private denylist before publication.
- `bunx --no-install eslint runtime/workers/codex-in-repl.ts runtime/workers/codex-in-repl.test.ts`: exit 0.

No product decision changed. Deliberately excluded host wiring, other runners,
headless fallback, live binary calls and live child-death experiments. Used the
staged evidence per the addendum, and no network documentation lookup. The
checked-out branch was `rebuild/codex-in-repl-2` (`git branch --show-current`);
retained it rather than switching worktrees. This single record uses the task's
explicit `.trident/as-built/rebuild/codex-in-repl.md` destination, overriding the
general docs/as-built location for this lane. Local commit only; the orchestrator
owns publication and review.
