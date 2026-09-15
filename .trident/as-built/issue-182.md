## Issue 182 — repeated push taps navigate

### Built

The dispatcher now labels its two inputs at app/lib/push.ts:353 and app/lib/push.ts:360. The source-aware guard at app/lib/push-tap-replay.ts:9-14 skips an identifier only when it came from the cached cold-start response; a response delivered by the warm listener continues through route resolution at app/lib/push.ts:335-339. Both inputs still mark identifiers at app/lib/push.ts:325, so persisted cold-start replay protection remains continuously maintained without depending on the notification provider clearing its cached response.

The behavioral test at app/__tests__/push-deep-link-routing.test.ts:304-313 exercises both classifications and pins each production call site. Existing comments describing issue 182 as still open were corrected at app/components/ChatSyncSurface.tsx:674-688 and app/__tests__/chat-push-tap-lands-on-the-message.test.tsx:377-381. The complete-tree phrase sweep retained hits only in frozen historical records at docs/AS_BUILT.md and unrelated features whose repeated actions remain intentionally inert.

### Decisions

I chose cold-start-only dedupe because Expo's response listener represents a new interaction, while the last-response API supplies cached launch state. One shared store remains: warm responses mark it so the corresponding cached response cannot replay after a later launch. No new error, verdict, state, or refusal was introduced, so there is no outcome vocabulary or default classification to extend.

I extracted only the replay predicate into a React-Native-independent module. The existing wrapper source checks remain necessary to establish that the cold and warm adapters pass the right classification, while the pure test establishes the classification behavior in both directions.

### Mutation table

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| app/lib/push-tap-replay.ts:14 classifies only `cold-start` as replayable | Changed the comparison to `warm-listener`; the printed mutation landed at line 14 | `bun test app/__tests__/push-deep-link-routing.test.ts` failed “skips cached cold-start replays but routes repeated warm taps”: expected true, received false | The same file passed all 24 tests after restoring `cold-start`; the final two-file run passed 35 tests |

### Validation

`bun test app/__tests__/push-deep-link-routing.test.ts app/__tests__/chat-push-tap-lands-on-the-message.test.tsx` passed 35 tests with 1,228 assertions. `EXPO_NO_TELEMETRY=1 bun run --cwd app lint` completed with zero errors and 21 existing warnings. `bun run --cwd app typecheck` could not run because the installed dependency tree lacks the implicit `@types` type-definition entry; TypeScript stopped with TS2688 before checking source files.

### Deliberately not changed

The seven-day store lifetime remains at app/lib/push-tap-dedupe-store.ts:53 because it bounds persisted replay history and is not the cause once only cold-start responses consult membership. Cold-start dismissal remains at app/lib/push.ts:326-332 as defense in depth. The frozen docs/AS_BUILT.md was not rewritten even though historical entries accurately describe the defect before this change. No product decision in SPEC.md changed.
