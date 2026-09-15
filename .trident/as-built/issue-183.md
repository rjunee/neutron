## Issue 183 — collision-proof General scope

### Built

The docs, Work Board, tabs, and activity clients now preserve the reserved scope segment through their URL/scope boundaries (`app/lib/docs-client.ts:130-132`, `app/lib/work-board-client.ts:176-182`, `app/lib/tabs-client.ts:89-90`, `app/lib/activity-client.ts:122-132`). Their HTTP surfaces share one exact resolver that accepts the reserved value while retaining the existing project-id validator for every other value (`gateway/http/scope-segment.ts:5-8`).

Work Board General uses the reserved id and still maps to the legacy owner-keyed rows, while a project named `general` maps to its own key (`work-board/store.ts:227-261`). Activity uses the reserved value as its in-memory key, separating its frames and snapshots from that project (`open/activity-inspector.ts:51-58`).

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

The restored focused command ran the nine touched test files: 244 passed, 0 failed. The typecheck matrix passed 50 server/root configurations; `app/tsconfig.json` could not start because the installed dependency tree lacks its implicit `@types` library. Expo lint could not start because the sandbox prevents creating its user-level configuration directory. `git diff --check` passed. The leak scan passed its available tiers but could not run its local PII tier because the external denylist is absent.

### Deliberately not built

No project rename path or project-id reservation was added: the reserved segment makes both scopes coexist. No database migration was added because legacy General Work Board rows already use the owner key (`work-board/store.ts:238-244`). `SPEC.md` was not changed because the issue selected an existing direction rather than changing a product decision.
