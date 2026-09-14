## Issue #597 — mount the documented REPL recovery endpoint

### What changed

The Open composer now builds the existing admin recovery surface with the canonical supervision registry path and the resolved owner token, then assigns its handler to the route ladder at `open/composer.ts:4019-4026,7214-7218`. The route slot was promoted from the unserved inventory into the append-only served baseline at `open/__tests__/route-slot-coverage-inventory.ts:102-107`.

The regression probe now calls both `POST /admin/respawn-session` and an invented sibling through the composed product's real `graph.fetch` at `open/__tests__/route-slot-coverage.test.ts:178-202`. Its assertion requires the recovery route's structured auth refusal while preserving the sibling's default 404 at `open/__tests__/route-slot-coverage.test.ts:259-266`.

### Decisions and rationale

The force-respawn closure uses `deriveReplSupervisionPaths(owner_home).replRegistryPath` because that function owns the supervision-state layout at `runtime/adapters/claude-code/index.ts:271-307`, and `respawnSupervisedSession` rejects a session registered to a different path at `runtime/adapters/claude-code/persistent/supervision.ts:58-77`. The surface uses the already-resolved owner token because the Open composer validates a configured credential or selects a fresh loopback-safe token at `open/composer.ts:2010-2029`; no second operator secret or configuration state was introduced.

No new error or verdict was added. The existing recovery outcome vocabulary remains the switch in `runtime/adapters/claude-code/persistent/admin-respawn-session.ts:43-74`: known failures map to their existing HTTP statuses and its existing default maps an unclassified failure to 500.

The mount invariant is maintained continuously in two independent ways: `OpenComposition` requires the field at compile time at `open/composer.ts:222-265`, and the served-slot plus HTTP probes fail if the composer stops carrying or routing it at `open/__tests__/route-slot-coverage.test.ts:259-312`. These checks do not depend on a live REPL or the respawn actuation succeeding; the request stops at the surface's auth gate.

### Mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| `admin_respawn_handler` composer assignment | Deleted the assignment; the printed landing point showed the comment immediately followed by the Telegram block at `open/composer.ts:7214-7216` | `bun test open/__tests__/route-slot-coverage.test.ts`: recovery changed from 403/structured `forbidden` to 404/`Not Found`; the served-slot ratchet also reported `admin-respawn` lost | Same command: 5 pass, 0 fail |

### Verification

- `bun test open/__tests__/route-slot-coverage.test.ts` — 5 pass, 0 fail.
- `bunx tsc -p open/tsconfig.json --noEmit` — green.
- `git diff --check` — green.
- `scripts/ci/leak-gate.sh --tree .` — all locally runnable tiers reported 0 findings; the command exited 3/incomplete because the out-of-repository PII denylist is unavailable in this lane.
- The root package has no `typecheck` script, so `bun run typecheck` reports `Script not found "typecheck"`; the package-level TypeScript command above is the repository-local equivalent for `open/`.
- The targeted root ESLint invocation reaches an existing inline `@typescript-eslint/no-explicit-any` directive at `open/__tests__/route-slot-coverage.test.ts:175`, but the root ESLint installation does not define that rule. No assertion or lint rule was weakened to hide it.

### Deliberately not done

No files under the persistent runtime adapter were changed. The recovery handler, its rate limit, its outcome taxonomy, and the force-respawn actuation remain unchanged; this change only makes their existing route reachable. No feature flag or alternate routing path was added. The unrelated unserved route-slot inventory begins at `open/__tests__/route-slot-coverage-inventory.ts:306-313` and was not changed beyond removing the repaired entry.
