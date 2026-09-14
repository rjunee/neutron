## 2026-09-14 — An in-flight reply survives the gateway hand-off

### What changed

The reply tool now sends through a dedicated hand-off policy instead of the generic three-attempt POST helper (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:200-207`). The policy retries the identical body for 60 seconds (`runtime/adapters/claude-code/persistent/reply-delivery.ts:12-18`, `runtime/adapters/claude-code/persistent/reply-delivery.ts:45-85`). A successful successor response remains `delivered`; a 401 still present at the deadline becomes `peer-gone`; a transport failure at the deadline remains the separate `delivery-unknown` state (`runtime/adapters/claude-code/persistent/reply-delivery.ts:67-82`).

Neither terminal non-delivery result contains the raw connection exception, and both tell the agent to end the turn without issuing a duplicate reply (`runtime/adapters/claude-code/persistent/reply-delivery.ts:20-28`). The existing outer catch remains the default vocabulary for unexpected tool failures (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:216-219`); all expected reply delivery outcomes are classified before reaching it.

### Decisions

The 60-second hand-off window is tied to the existing 45-second boot-adoption evidence bound (`runtime/adapters/claude-code/persistent/boot-adoption.ts:176`), leaving time for the adopted session's credential to be registered (`runtime/adapters/claude-code/persistent/boot-adoption.ts:2743-2749`). This is coherent now because the sink coordinates persist across gateway processes (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:4-24`). It is not a claim about an unmeasured machine restart duration.

The outcome vocabulary is the exhaustive `ReplyDeliveryOutcome` union (`runtime/adapters/claude-code/persistent/reply-delivery.ts:15-18`) and its exhaustive tool-result switch (`runtime/adapters/claude-code/persistent/reply-delivery.ts:20-28`). The default is therefore compile-time refusal when a new kind is added, rather than silently treating it as delivered. Unknown stays distinct from a definitive 401 rejection (`runtime/adapters/claude-code/persistent/reply-delivery.ts:70-82`).

The continuously maintained invariant is that the terminal reply body is retried unchanged until one classified outcome is reached. The helper builds the body once per attempt from the same input (`runtime/adapters/claude-code/persistent/reply-delivery.ts:45-66`), while the caller builds the correlated session/text/turn body once before entering the helper (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:200-206`). The runtime-armed mechanism is the production reply handler itself (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:194-207`).

### Mutation table

| Guard | Compile-valid mutation | Red result | Restored result |
|---|---|---|---|
| HTTP success gate (`reply-delivery.ts:67`) | Inverted `response.ok` | Three delivery/rejection cases red | 5 pass, 0 fail |
| Rejection classifier (`reply-delivery.ts:70`) | Changed status equality to inequality | `peer still rejected` red | 5 pass, 0 fail |
| Handoff deadline (`reply-delivery.ts:81`) | Inverted `>=` to `<=` | Both successor recovery cases red | 5 pass, 0 fail |
| Peer-gone tool result (`reply-delivery.ts:24-25`) | Returned `delivered` | Terminal-result case red | 5 pass, 0 fail |

Each mutation's landed line and diff was printed before the named test run. Every mutation was restored before the green run.

### Verification

`bun test runtime/adapters/claude-code/persistent/__tests__/reply-delivery.test.ts`: 5 pass, 0 fail, 13 assertions (`runtime/adapters/claude-code/persistent/__tests__/reply-delivery.test.ts:30-91`). `bash scripts/ci/lint.sh`: all nine reported gates green. `bash scripts/ci/typecheck-all.sh` checked 51 projects; the touched `runtime/tsconfig.json` passed, while the full matrix remained red on pre-existing errors in three untouched test helpers. `git diff --name-only origin/main --` over those three paths returned no output; the branch does not change them.

### Deliberately not changed

The generic bounded POST helper remains for non-terminal typing and readiness notifications (`runtime/adapters/claude-code/persistent/dev-channel-impl.ts:209-211`, `runtime/adapters/claude-code/persistent/dev-channel-impl.ts:315-336`). Their failure cannot duplicate a terminal response. No durable inbox was added: the already-shipped stable sink coordinates and session adoption make direct retry to the successor possible (`runtime/adapters/claude-code/persistent/sink-coordinates.ts:4-24`, `runtime/adapters/claude-code/persistent/boot-adoption.ts:2743-2749`). No feature flag or alternate reply path was added.

`SPEC.md` was not edited. Its governance preamble assigns its Decisions Log to the owner (`SPEC.md:11-20`), and this change completes the existing restart-survival architecture rather than changing that product direction. The full test suite was not run, per the lane instruction.
