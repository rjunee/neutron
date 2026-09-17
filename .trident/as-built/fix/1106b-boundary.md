## 2026-09-17 — Bound dispatch consumption to the current turn (#1106)

### Change and evidence

The branch captures transcript size and identity before submission, under the turn
slot (`runtime/workers/claude-acting-turn.ts:76`, :163, :174). Only subsequent exact
user string/text-block matches prove consumption (:107–119). The existing three
states remain `consumed`, `not-consumed`, and `unreadable` (:71).

Reproduced the blocking review finding before editing production: the held-open
caller regression expected two submitted commands after 40ms and received one.
The baseline open at :91 could keep the slot until the held operation completed;
the baseline outer race returned unknown without releasing that slot (:193–199).
Those review citations were accurate on the starting branch. The filed issue's
transcript-path citation (:49–50) now resolves to :138.

The diagnostic now races its entire open/stat/read/close operation against caller
cancellation and the remaining host budget (:89–96, :125). Cancellation is
`unreadable` (:94). An outer interruption during the diagnostic cancels it and waits
for that bounded observation to release the slot, preserving the diagnostic detail
(:217–219, :210). Normal string/block/negative classification remains at :115–122.

Reading starts under the slot. Late open/stat completion checks cancellation before
starting another operation (:104, :106); readFile receives the abort signal (:109).
A late handle is closed (:110), even though the cancelled observation already
released the slot. The timer/race is host-owned and does not require the REPL or a
stalled filesystem operation to complete. Open itself cannot be forcibly cancelled
by this API: a permanently stalled open retains its pending cleanup continuation,
but cannot retain the turn slot or initiate a later transcript read.

The vocabulary is unchanged: consumption states map explicitly to the existing
`unknown` outcome (:193–203). `runtime/workers/project-runners.ts:31` declares it;
:138 and :146 preserve its detail through the non-ended branch. There is no new
outcome relying on an implicit default. `grep -c observeSubagents
runtime/workers/claude-acting-turn.ts` returned **2**; the observer's readable,
absent, and unreadable vocabulary remains at :39 and :57–68.

### Acceptance and decisions

The existing table at `runtime/workers/claude-acting-turn.test.ts:439` enumerates
11 normal/boundary scenarios and still checks one expiry-only open (:496).
The new nested table (:522–524) enumerates seven cases: open/stat/read crossed with
caller/deadline, plus cancellation at diagnostic entry for open. Its serial slot
queue (:533) holds the first operation unresolved (:564, :571, :576). Assertions
prove that the second dispatch submits and both slots release before unblocking
the first operation (:602–605). Late completion checks no new stat/read is started
and the interrupted read actually rejects with AbortError (:608–610).

Use the remaining host budget, not a fresh dispatch budget. Keep the diagnostic
inside turn ownership; detach only cancellation cleanup. A read can use remaining
budget after dispatch observation expires, so expiry-only I/O is not a claim of
zero timing cost. It cannot keep the slot waiting for stalled I/O after that bound.
A distinctive-phrase search across runtime, docs and hidden records used
`expiry-only|not per-poll I/O|does not alter dispatch timing|timing characteristics|One read at expiry`.
It found this branch's previous size-cost sentence and the positive-control source
comment at :85. This record replaces the former timing claim with the bound above.

No product/spec decision changed. Deliberately did not add retries, flags, an
alternate dispatch path, new outcome values, or move transcript observation outside
the slot. Boundary capture and subagent polling cancellation are outside this fix.
Re-read docs/process/work-tracking.md before updating this record; the task explicitly
selects this staging path rather than the normal docs/as-built path.

### Mutation proof for this revision

Each changed line was printed before running. Command for every row:
`bun test runtime/workers/claude-acting-turn.test.ts -t 'stalled transcript <filter>'`.
Every mutation exited **1**, and restoration with the same filter exited **0**.
Lines refer to `runtime/workers/claude-acting-turn.ts`.

| Guard | Printed mutation | Filter | Observed RED; restored GREEN |
|---|---|---|---|
| Race :125 | `return await read()` | open releases the slot on caller | one command instead of two; 1 pass |
| Deadline :91 | timer delay becomes 60000 | open releases the slot on deadline | one command instead of two; 1 pass |
| Classification :94 | resolve not-consumed | open releases the slot on caller | false never-consumed detail; 1 pass |
| Already cancelled :96 | `if (false) cancel()` | open releases the slot on already cancelled | one command instead of two; 1 pass |
| Late open :104 | remove abort check | open releases the slot on caller | one late stat instead of zero; 1 pass |
| Late stat :106 | remove abort check | stat releases the slot on caller | one late read instead of zero; 1 pass |
| Read cancellation :109 | remove readFile signal | read releases the slot on caller | read did not reject with AbortError; 1 pass |
| Outer detail :217 | `if (false)` | open releases the slot on caller | generic trailer detail instead of unreadable; 1 pass |

### Verification

- `bun run typecheck`: script unavailable; used `bunx tsc --noEmit`, exit **0**.
- `bun test runtime/workers/claude-acting-turn.test.ts`: **60 pass, 0 fail**, 239 assertions.
- `bash scripts/ci/lint.sh`: exit **0**, all listed gates green.
- `git diff --check`: exit **0**.
- Exactly one `## ` heading in this shard. No whole-suite or network operation.
