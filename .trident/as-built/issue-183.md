## Issue 183 — collision-proof General scope

### Built

The docs, Work Board, tabs, and activity clients now preserve the reserved scope segment through their URL/scope boundaries (`app/lib/docs-client.ts:130-132`, `app/lib/work-board-client.ts:176-182`, `app/lib/tabs-client.ts:89-90`, `app/lib/activity-client.ts:122-132`). Their HTTP surfaces share one exact resolver that accepts the reserved value while retaining the existing project-id validator for every other value (`gateway/http/scope-segment.ts:5-8`).

Work Board General uses the reserved id and still maps to the legacy owner-keyed rows, while a project named `general` maps to its own key (`work-board/store.ts:225-260`). Activity uses the reserved value as its in-memory key, separating its frames and snapshots from that project (`open/activity-inspector.ts:51-58`).

General's existing docs state moves at boot before any docs stores are constructed (`open/composer.ts:3665-3668`). The migration enumerates the four docs-owned components—working tree, version repository, binary index/blob store, and comment store—and moves each with an atomic rename (`gateway/docs-general-scope-migration.ts:6-7`, `gateway/docs-general-scope-migration.ts:24-38`).

### Decisions

Existing content stays with General, matching the issue's selected direction; a project named `general` begins with an empty docs surface. Each component move is independently restart-safe. If both old and new locations exist for one component, the migration throws (`gateway/docs-general-scope-migration.ts:29-37`). This new refusal joins boot/composition exceptions and therefore aborts startup by default; it never asks the potentially broken client to maintain the invariant.

The old client mapper was deleted rather than retained as a second path. The exact server resolver is shared by all four surfaces (`gateway/http/scope-segment.test.ts:15-25`).

### Mutation evidence

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Reserved server segment (`gateway/http/scope-segment.ts:6`) | Return the ordinary validator result | Resolver, docs, tabs, and Work Board scope tests failed | Focused suite passed |
| Ambiguous migration refusal (`gateway/docs-general-scope-migration.ts:33`) | Bypass the existence condition | Refusal test failed with filesystem `ENOTEMPTY` | Migration tests passed |
| Four client mapper imports | Alias the removed legacy mapper into each client | 11 URL/scope tests failed | Client tests passed |
| Work Board reserved id (`work-board/store.ts:225`) | Change `~general` back to `general` | Exact constant assertion failed | Work Board scope test passed |
| Agent-tool General fixtures (`work-board/agent-tool.test.ts:197-203`, `work-board/agent-tool.test.ts:283-292`) | Retain the former `general` inputs | Two agent-tool assertions failed | Agent-tool file passed |
| Activity General fixture (`app/__tests__/work-board-activity.test.ts:206-226`) | Retain the former `general` event scope | Same-scope delivery assertion failed | Activity file passed |

The original restored focused command ran the eight changed test files: 224 passed, 0 failed. The typecheck matrix passed 50 server/root configurations; `app/tsconfig.json` could not start because the installed dependency tree lacks its implicit `@types` library. Expo lint could not start because the sandbox prevents creating its user-level configuration directory. `git diff --check` passed. The leak scan passed its available tiers but could not run its local PII tier because the external denylist is absent.

### Follow-up: package boundary

The Work Board package does not declare wire types (`work-board/package.json:6-12`), and the store already receives the HTTP project id as an argument (`work-board/store.ts:254-260`). The reserved value therefore remains package-local (`work-board/store.ts:219-225`) instead of adding a new dependency edge. The store test now pins both directions: `~general` maps to the owner key while the legal project id `general` remains distinct (`work-board/store.test.ts:1232-1239`). Existing agent-tool and activity fixtures were updated to exercise the same reserved value (`work-board/agent-tool.test.ts:197-203`, `work-board/agent-tool.test.ts:283-292`, `app/__tests__/work-board-activity.test.ts:206-226`).

The first mutation changed the constant to `general` but stayed green because the test passed the exported constant back into its own mapper. After replacing that self-referential fixture with literal inputs, the same mutation failed and the restored value passed. The eight branch-changed files passed 224/224, the two corrected fixture files passed 67/67, and the Work Board directory passed 297/297. The 51-project typecheck matrix passed 50 projects, including `work-board/tsconfig.json`, and retained only the documented app implicit-type-library failure. Repository lint passed all reported guards.

### Deliberately not built

No project rename path or project-id reservation was added: the reserved segment makes both scopes coexist. No database migration was added because legacy General Work Board rows already use the owner key (`work-board/store.ts:237-243`). `SPEC.md` was not changed because the issue selected an existing direction rather than changing a product decision.

No `wire-types` dependency or path mapping was added to Work Board: the store needs only the caller-provided reserved value, not wire-topic behavior.
