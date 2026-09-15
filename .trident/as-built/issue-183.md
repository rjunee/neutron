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

### Follow-up: complete scope-key propagation

The activity tap already writes through `inspectorScopeKey` (`open/composer.ts:4768-4779`), but the General HTTP snapshot queried the former literal. The surface now accepts the same resolver (`gateway/http/activity-surface.ts:55-84`), and the composer supplies `inspectorScopeKey` (`open/composer.ts:4805-4808`). The real-composer surface assertion pins the returned reserved key (`open/__tests__/activity-inspector-served.test.ts:206-213`). There is one activity spelling and no fallback read.

The reflection hook's chat scope still uses `general` for session behavior, but its nexus boundary now sends `GENERAL_RAIL_ID` when `project_id` is absent (`gateway/wiring/build-live-agent-turn.ts:1890-1905`). `wireMemory` then applies the single Work Board key function (`open/wiring/memory.ts:317-329`), whose General mapping is maintained centrally (`work-board/store.ts:260-266`). The regression proves the correction lands under the owner key and the distinct project key `general` stays empty (`open/__tests__/open-wiring-memory.test.ts:162-195`).

The required caller enumeration used `grep -rn --include='*.ts' 'workBoardScopeKey' .`; its positive control was the known definition at `work-board/store.ts:260`. Production calls were accounted for in Work Board agent tools, Trident build tools, agent dispatch, the Open composer and nexus reader, the gateway Work Board surface, and core-module composition. All pass a nullable/reserved project id or an already-real project id. The sole lagging producer was reflection's semantic General value at `open/wiring/memory.ts:328`; it is now normalized before that call. Documentation/test hits were declarations, imports, assertions, or comments; the stale comments that claimed literal `general` mapped to General were corrected.

### Follow-up mutation evidence

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| Activity surface resolver (`gateway/http/activity-surface.ts:84`) | Restore literal `general` | Real-composer General surface assertion received `general`, expected `~general` | Focused real-composer surface case passed |
| Reflection boundary (`gateway/wiring/build-live-agent-turn.ts:1904`) | Pass the chat `scope` unchanged | Reflection wiring assertion received `general`, expected `~general` | Reflection wiring file passed 4/4; memory wiring file passed 12/12 |

The four touched behavioral files passed 105 tests. The full activity served file passed its four non-listener cases; its four POST cases could not start the loopback sink in the build sandbox and stopped before their assertions. The repository typecheck matrix passed all 51 configurations, repository lint passed every reported guard, and `git diff --check` passed.

### Follow-up deliberately not built

No fallback read of the former activity key was added. No alias from a real project named `general` to General was restored: `workBoardScopeKey` continues to keep that legal project id distinct (`work-board/store.test.ts:1233-1239`). No outcome vocabulary changed; these boundaries now select existing scope keys and introduce no error, verdict, state, or refusal. `SPEC.md` was not changed because this completes the existing collision-proof General decision.

### Historical round-three enumeration before the ruling (2026-09-15)

The requested recursive grep over TypeScript and TSX, excluding dependency and Git directories, returned **372 matching lines in 117 files** in the build worktree. This is an enumeration of that pattern, not all semantic scope consumers. Every hit is classified below; grouped rows list every matching line. Imports are reader bindings; fixture construction and assertions are distinguished. Diagnostic/session values are not automatically HTTP ids.

```sh
grep -rn "workBoardScopeKey\|GENERAL_HTTP_ID\|'~general'\|\"general\"\|'general'" --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=.git .
```

Positive controls from that same command: `work-board/store.ts:260` finds the known `workBoardScopeKey` definition; `landing/chat-react/general-scope.ts:30` finds `GENERAL_HTTP_ID`; `wire-types/topic-id.ts:43` finds the reserved literal.

| File and matching lines | Classification |
| --- | --- |
| `agent-dispatch/service.ts:212` | documentation |
| `agent-dispatch/tool.ts:24` | reader (binding) |
| `agent-dispatch/tool.ts:144` | writer (scope/value construction) |
| `app/__tests__/activity-client.test.ts:7`, `app/__tests__/activity-client.test.ts:8` | documentation |
| `app/__tests__/activity-client.test.ts:53`, `app/__tests__/activity-client.test.ts:88`, `app/__tests__/activity-client.test.ts:89` | reader (assertion) |
| `app/__tests__/general-rail-scope.test.ts:67` | documentation (test name) |
| `app/__tests__/general-rail-scope.test.ts:63`, `app/__tests__/general-rail-scope.test.ts:70`, `app/__tests__/general-rail-scope.test.ts:71`, `app/__tests__/general-rail-scope.test.ts:72` | reader (assertion) |
| `app/__tests__/general-scope.test.ts:10`, `app/__tests__/general-scope.test.ts:18` | documentation |
| `app/__tests__/general-scope.test.ts:191`, `app/__tests__/general-scope.test.ts:242` | documentation (test name) |
| `app/__tests__/general-scope.test.ts:63`, `app/__tests__/general-scope.test.ts:64` | reader (assertion) |
| `app/__tests__/general-scope.test.ts:27`, `app/__tests__/general-scope.test.ts:247`, `app/__tests__/general-scope.test.ts:249`, `app/__tests__/general-scope.test.ts:250`, `app/__tests__/general-scope.test.ts:251`, `app/__tests__/general-scope.test.ts:252`, `app/__tests__/general-scope.test.ts:253` | writer (fixture/input) |
| `app/__tests__/general-tab-set.test.tsx:10` | documentation |
| `app/__tests__/imessage-chat-ux.test.tsx:316`, `app/__tests__/imessage-chat-ux.test.tsx:377` | writer (fixture/input) |
| `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:69`, `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:113` | documentation |
| `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:120`, `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:139` | reader (assertion) |
| `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:43` | reader (binding) |
| `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:58`, `app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts:149` | writer (fixture/input) |
| `app/__tests__/login-first-discovery.test.ts:93` | writer (fixture/input) |
| `app/__tests__/project-shell-chrome-persistence.test.ts:136` | documentation |
| `app/__tests__/project-shell-chrome-persistence.test.ts:141` | reader (assertion) |
| `app/__tests__/project-shell-chrome-persistence.test.ts:145` | writer (fixture/input) |
| `app/__tests__/push-foreground-policy.test.ts:120` | writer (fixture/input) |
| `app/__tests__/rail-order.test.ts:28`, `app/__tests__/rail-order.test.ts:78` | reader (assertion) |
| `app/__tests__/rail-order.test.ts:27` | writer (fixture/input) |
| `app/__tests__/server-config-wiring.test.ts:322` | writer (fixture/input) |
| `app/__tests__/server-url.test.ts:67` | writer (fixture/input) |
| `app/__tests__/work-board-activity.test.ts:33`, `app/__tests__/work-board-activity.test.ts:214`, `app/__tests__/work-board-activity.test.ts:224`, `app/__tests__/work-board-activity.test.ts:244` | writer (fixture/input) |
| `app/__tests__/work-board-general-scope.test.ts:8`, `app/__tests__/work-board-general-scope.test.ts:10`, `app/__tests__/work-board-general-scope.test.ts:11` | documentation |
| `app/__tests__/work-board-general-scope.test.ts:66`, `app/__tests__/work-board-general-scope.test.ts:75`, `app/__tests__/work-board-general-scope.test.ts:87` | reader (assertion) |
| `app/__tests__/work-board-general-scope.test.ts:83`, `app/__tests__/work-board-general-scope.test.ts:85`, `app/__tests__/work-board-general-scope.test.ts:92`, `app/__tests__/work-board-general-scope.test.ts:99`, `app/__tests__/work-board-general-scope.test.ts:103`, `app/__tests__/work-board-general-scope.test.ts:107`, `app/__tests__/work-board-general-scope.test.ts:110`, `app/__tests__/work-board-general-scope.test.ts:111`, `app/__tests__/work-board-general-scope.test.ts:115`, `app/__tests__/work-board-general-scope.test.ts:119` | writer (fixture/input) |
| `app/__tests__/workboard-doc-link.test.tsx:67` | writer (fixture/input) |
| `app/app/projects/[id]/_layout.tsx:205`, `app/app/projects/[id]/_layout.tsx:731`, `app/app/projects/[id]/_layout.tsx:732` | documentation |
| `app/app/projects/[id]/_layout.tsx:775` | reader |
| `app/app/projects/[id]/workboard.tsx:26` | documentation |
| `app/lib/activity-client.ts:108`, `app/lib/activity-client.ts:111`, `app/lib/activity-client.ts:113`, `app/lib/activity-client.ts:118`, `app/lib/activity-client.ts:321` | documentation |
| `app/lib/docs-client.ts:123` | documentation |
| `app/lib/entry-route.ts:22` | documentation |
| `app/lib/general-scope.ts:48`, `app/lib/general-scope.ts:51` | HTTP path segment |
| `app/lib/general-scope.ts:7`, `app/lib/general-scope.ts:14` | documentation |
| `app/lib/project-rail-view.ts:60` | client sentinel |
| `app/lib/project-rail-view.ts:36`, `app/lib/project-rail-view.ts:38`, `app/lib/project-rail-view.ts:75` | documentation |
| `app/lib/project-state-reducer.ts:123` | documentation |
| `app/lib/project-state.tsx:141` | documentation |
| `app/lib/push-foreground-policy.ts:46`, `app/lib/push-foreground-policy.ts:53` | documentation |
| `app/lib/reminders-client.ts:12` | documentation |
| `app/lib/tabs-client.ts:77`, `app/lib/tabs-client.ts:84` | documentation |
| `app/lib/work-board-client.ts:166` | documentation |
| `app/lib/work-board-live.ts:161` | documentation |
| `cores/free/reminders/__tests__/convert-to-task-tool.test.ts:189` | reader (assertion) |
| `cores/free/reminders/__tests__/convert-to-task-tool.test.ts:143`, `cores/free/reminders/__tests__/convert-to-task-tool.test.ts:169`, `cores/free/reminders/__tests__/convert-to-task-tool.test.ts:186` | writer (fixture/input) |
| `gateway/__tests__/app-docs-surface.test.ts:137` | reader (assertion) |
| `gateway/__tests__/app-docs-surface.test.ts:138` | writer (fixture/input) |
| `gateway/__tests__/app-reminders-surface.test.ts:667`, `gateway/__tests__/app-reminders-surface.test.ts:669` | writer (fixture/input) |
| `gateway/__tests__/app-tabs-surface.test.ts:210`, `gateway/__tests__/app-tabs-surface.test.ts:211` | reader (assertion) |
| `gateway/__tests__/projects-read-does-not-create.test.ts:54`, `gateway/__tests__/projects-read-does-not-create.test.ts:108`, `gateway/__tests__/projects-read-does-not-create.test.ts:115` | reader (assertion) |
| `gateway/__tests__/projects-read-does-not-create.test.ts:52`, `gateway/__tests__/projects-read-does-not-create.test.ts:111`, `gateway/__tests__/projects-read-does-not-create.test.ts:114` | writer (fixture/input) |
| `gateway/__tests__/reset-command-wiring.test.ts:208` | documentation (test name) |
| `gateway/__tests__/reset-command-wiring.test.ts:217` | reader (assertion) |
| `gateway/__tests__/reset-command-wiring.test.ts:189` | writer (fixture/input) |
| `gateway/composition/build-core-modules.ts:29` | reader (binding) |
| `gateway/composition/build-core-modules.ts:401` | writer (scope/value construction) |
| `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts:180` | reader (assertion) |
| `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts:165`, `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts:178`, `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts:218`, `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts:254` | writer (fixture/input) |
| `gateway/docs-general-scope-migration.test.ts:32`, `gateway/docs-general-scope-migration.test.ts:33` | reader (assertion) |
| `gateway/docs-general-scope-migration.test.ts:23`, `gateway/docs-general-scope-migration.test.ts:39`, `gateway/docs-general-scope-migration.test.ts:40` | writer (fixture/input) |
| `gateway/docs-general-scope-migration.ts:6` | reader (migration source) |
| `gateway/http/scope-segment.test.ts:7`, `gateway/http/scope-segment.test.ts:8`, `gateway/http/scope-segment.test.ts:9` | reader (assertion) |
| `gateway/http/work-board-surface.test.ts:69` | documentation |
| `gateway/http/work-board-surface.test.ts:917` | reader (assertion) |
| `gateway/http/work-board-surface.test.ts:8` | reader (binding) |
| `gateway/http/work-board-surface.test.ts:71` | writer (fixture/input) |
| `gateway/http/work-board-surface.ts:25`, `gateway/http/work-board-surface.ts:398`, `gateway/http/work-board-surface.ts:649` | documentation |
| `gateway/http/work-board-surface.ts:40` | reader (binding) |
| `gateway/http/work-board-surface.ts:287` | writer (scope/value construction) |
| `gateway/nexus/nexus-fragment.ts:180` | documentation |
| `gateway/proactive/__tests__/work-wakeup-selection.test.ts:264` | reader (assertion) |
| `gateway/proactive/work-wakeup-selection.ts:93`, `gateway/proactive/work-wakeup-selection.ts:94` | documentation |
| `gateway/proactive/work-wakeup-selection.ts:96` | writer (scope/value construction) |
| `gateway/proactive/work-wakeup.ts:193`, `gateway/proactive/work-wakeup.ts:194` | documentation |
| `gateway/push/__tests__/ritual-post-notifies-as-a-chat-message.test.ts:252` | reader (assertion) |
| `gateway/push/chat-message-push.test.ts:265` | reader (assertion) |
| `gateway/transcription/__tests__/openai-key-store.test.ts:112` | documentation |
| `gateway/wiring/__tests__/build-live-agent-turn-activity-inspector.test.ts:142` | documentation |
| `gateway/wiring/__tests__/build-live-agent-turn-activity-inspector.test.ts:152`, `gateway/wiring/__tests__/build-live-agent-turn-activity-inspector.test.ts:153` | reader (assertion) |
| `gateway/wiring/__tests__/build-live-agent-turn-overlap.test.ts:275` | reader (assertion) |
| `gateway/wiring/__tests__/build-live-agent-turn-reflection.test.ts:109` | reader (assertion) |
| `gateway/wiring/__tests__/build-live-agent-turn-session-isolation.test.ts:156` | documentation |
| `gateway/wiring/__tests__/build-live-agent-turn-session-isolation.test.ts:157` | reader (assertion) |
| `gateway/wiring/__tests__/build-live-agent-turn.test.ts:384`, `gateway/wiring/__tests__/build-live-agent-turn.test.ts:428` | reader (assertion) |
| `gateway/wiring/__tests__/live-agent-scope-fragment.test.ts:17`, `gateway/wiring/__tests__/live-agent-scope-fragment.test.ts:27` | writer (fixture/input) |
| `gateway/wiring/__tests__/operating-doctrine.test.ts:198` | reader (assertion) |
| `gateway/wiring/__tests__/operating-doctrine.test.ts:19`, `gateway/wiring/__tests__/operating-doctrine.test.ts:27`, `gateway/wiring/__tests__/operating-doctrine.test.ts:40`, `gateway/wiring/__tests__/operating-doctrine.test.ts:89`, `gateway/wiring/__tests__/operating-doctrine.test.ts:109`, `gateway/wiring/__tests__/operating-doctrine.test.ts:118`, `gateway/wiring/__tests__/operating-doctrine.test.ts:156`, `gateway/wiring/__tests__/operating-doctrine.test.ts:178`, `gateway/wiring/__tests__/operating-doctrine.test.ts:187`, `gateway/wiring/__tests__/operating-doctrine.test.ts:197` | writer (fixture/input) |
| `gateway/wiring/build-live-agent-turn.ts:39`, `gateway/wiring/build-live-agent-turn.ts:641`, `gateway/wiring/build-live-agent-turn.ts:892`, `gateway/wiring/build-live-agent-turn.ts:1816` | documentation |
| `gateway/wiring/build-live-agent-turn.ts:1094`, `gateway/wiring/build-live-agent-turn.ts:1123`, `gateway/wiring/build-live-agent-turn.ts:1531`, `gateway/wiring/build-live-agent-turn.ts:1621`, `gateway/wiring/build-live-agent-turn.ts:2059`, `gateway/wiring/build-live-agent-turn.ts:2072`, `gateway/wiring/build-live-agent-turn.ts:2142` | writer (scope/value construction) |
| `gateway/wiring/live-agent-scope-fragment.ts:20` | documentation (type vocabulary) |
| `gateway/wiring/operating-doctrine.ts:45` | documentation (type vocabulary) |
| `landing/chat-react/__tests__/activity-client.test.ts:152` | documentation |
| `landing/chat-react/__tests__/activity-client.test.ts:154`, `landing/chat-react/__tests__/activity-client.test.ts:155` | reader (assertion) |
| `landing/chat-react/__tests__/component.test.tsx:920`, `landing/chat-react/__tests__/component.test.tsx:1074` | writer (fixture/input) |
| `landing/chat-react/__tests__/controller.test.ts:116`, `landing/chat-react/__tests__/controller.test.ts:148`, `landing/chat-react/__tests__/controller.test.ts:169`, `landing/chat-react/__tests__/controller.test.ts:187`, `landing/chat-react/__tests__/controller.test.ts:190`, `landing/chat-react/__tests__/controller.test.ts:249` | writer (fixture/input) |
| `landing/chat-react/__tests__/general-docs-reachable.test.tsx:48` | documentation |
| `landing/chat-react/__tests__/general-docs-reachable.test.tsx:41`, `landing/chat-react/__tests__/general-docs-reachable.test.tsx:42`, `landing/chat-react/__tests__/general-docs-reachable.test.tsx:43`, `landing/chat-react/__tests__/general-docs-reachable.test.tsx:51`, `landing/chat-react/__tests__/general-docs-reachable.test.tsx:94` | reader (assertion) |
| `landing/chat-react/__tests__/general-docs-reachable.test.tsx:32` | reader (binding) |
| `landing/chat-react/__tests__/paste-attach.test.tsx:129` | writer (fixture/input) |
| `landing/chat-react/__tests__/project-shell.test.tsx:797`, `landing/chat-react/__tests__/project-shell.test.tsx:902` | documentation |
| `landing/chat-react/__tests__/project-shell.test.tsx:826` | writer (fixture/input) |
| `landing/chat-react/__tests__/stable-mount.test.tsx:276` | writer (fixture/input) |
| `landing/chat-react/__tests__/switch-timing.test.ts:51` | reader (assertion) |
| `landing/chat-react/__tests__/switch-timing.test.ts:35` | writer (fixture/input) |
| `landing/chat-react/__tests__/work-board-client.test.ts:148`, `landing/chat-react/__tests__/work-board-client.test.ts:149` | documentation |
| `landing/chat-react/__tests__/work-board-client.test.ts:151` | writer (fixture/input) |
| `landing/chat-react/activity-client.ts:141` | documentation |
| `landing/chat-react/activity-client.ts:145` | writer (scope/value construction) |
| `landing/chat-react/controller.ts:1133` | documentation |
| `landing/chat-react/general-scope.ts:30`, `landing/chat-react/general-scope.ts:41` | HTTP path segment |
| `landing/chat-react/general-scope.ts:12`, `landing/chat-react/general-scope.ts:15`, `landing/chat-react/general-scope.ts:20` | documentation |
| `landing/chat-react/switch-timing.ts:456`, `landing/chat-react/switch-timing.ts:457` | writer (diagnostic) |
| `landing/chat-react/tabs-client.ts:107` | documentation |
| `landing/chat-react/work-board-client.ts:228` | HTTP path segment |
| `landing/chat-react/work-board-client.ts:220`, `landing/chat-react/work-board-client.ts:221`, `landing/chat-react/work-board-client.ts:224` | documentation |
| `landing/chat-react/work-board-client.ts:36` | reader (binding) |
| `migrations/__tests__/scope-rekey.test.ts:13`, `migrations/__tests__/scope-rekey.test.ts:168` | documentation |
| `migrations/runner.test.ts:430` | writer (fixture/input) |
| `migrations/scope-rekey.ts:99` | documentation |
| `onboarding/history-import/__tests__/import-result-corrupt-policy.test.ts:53` | writer (fixture/input) |
| `onboarding/history-import/__tests__/import-result-store.test.ts:57`, `onboarding/history-import/__tests__/import-result-store.test.ts:88`, `onboarding/history-import/__tests__/import-result-store.test.ts:96`, `onboarding/history-import/__tests__/import-result-store.test.ts:126` | writer (fixture/input) |
| `onboarding/interview/__tests__/import-runner-hook-contract.test.ts:62` | reader (assertion) |
| `onboarding/interview/__tests__/import-runner-hook-contract.test.ts:38` | writer (fixture/input) |
| `onboarding/overnight/dispatcher.test.ts:192`, `onboarding/overnight/dispatcher.test.ts:199` | writer (fixture/input) |
| `onboarding/overnight/morning-brief.test.ts:120`, `onboarding/overnight/morning-brief.test.ts:139`, `onboarding/overnight/morning-brief.test.ts:155` | reader (assertion) |
| `onboarding/overnight/morning-brief.test.ts:114`, `onboarding/overnight/morning-brief.test.ts:134`, `onboarding/overnight/morning-brief.test.ts:150`, `onboarding/overnight/morning-brief.test.ts:180`, `onboarding/overnight/morning-brief.test.ts:195`, `onboarding/overnight/morning-brief.test.ts:206`, `onboarding/overnight/morning-brief.test.ts:219` | writer (fixture/input) |
| `open/__tests__/activity-inspector-served.test.ts:212` | reader (assertion) |
| `open/__tests__/memory-index-workboard-wiring.test.ts:31` | reader (binding) |
| `open/__tests__/memory-index-workboard-wiring.test.ts:108`, `open/__tests__/memory-index-workboard-wiring.test.ts:111`, `open/__tests__/memory-index-workboard-wiring.test.ts:160` | writer (fixture/input) |
| `open/__tests__/open-board-terminate-wiring.test.ts:39` | reader (binding) |
| `open/__tests__/open-board-terminate-wiring.test.ts:207`, `open/__tests__/open-board-terminate-wiring.test.ts:277` | writer (fixture/input) |
| `open/__tests__/open-terminal-build-wake-wiring.test.ts:28` | reader (binding) |
| `open/__tests__/open-terminal-build-wake-wiring.test.ts:217`, `open/__tests__/open-terminal-build-wake-wiring.test.ts:282`, `open/__tests__/open-terminal-build-wake-wiring.test.ts:321` | writer (fixture/input) |
| `open/__tests__/open-wiring-app-ws.test.ts:139` | writer (fixture/input) |
| `open/__tests__/open-wiring-memory.test.ts:157`, `open/__tests__/open-wiring-memory.test.ts:161` | documentation |
| `open/__tests__/open-wiring-memory.test.ts:162` | documentation (test name) |
| `open/__tests__/open-wiring-memory.test.ts:184`, `open/__tests__/open-wiring-memory.test.ts:195` | reader (assertion) |
| `open/__tests__/open-wiring-memory.test.ts:35` | reader (binding) |
| `open/__tests__/open-wiring-memory.test.ts:178`, `open/__tests__/open-wiring-memory.test.ts:182`, `open/__tests__/open-wiring-memory.test.ts:329`, `open/__tests__/open-wiring-memory.test.ts:427` | writer (fixture/input) |
| `open/activity-inspector.test.ts:264` | writer (fixture/input) |
| `open/activity-inspector.ts:46` | documentation |
| `open/activity-inspector.ts:52` | writer (scope definition) |
| `open/composer.ts:2138`, `open/composer.ts:2266`, `open/composer.ts:4681`, `open/composer.ts:4682`, `open/composer.ts:5724`, `open/composer.ts:5757` | documentation |
| `open/composer.ts:3074`, `open/composer.ts:4484`, `open/composer.ts:5740` | reader |
| `open/composer.ts:532` | reader (binding) |
| `open/composer.ts:2126`, `open/composer.ts:2269`, `open/composer.ts:2508`, `open/composer.ts:3082`, `open/composer.ts:4404`, `open/composer.ts:4457`, `open/composer.ts:4490`, `open/composer.ts:4782`, `open/composer.ts:5680` | writer (scope/value construction) |
| `open/wiring/__tests__/nexus-reader-seam.test.ts:6`, `open/wiring/__tests__/nexus-reader-seam.test.ts:70` | documentation |
| `open/wiring/__tests__/nexus-reader-seam.test.ts:15` | reader (binding) |
| `open/wiring/__tests__/nexus-reader-seam.test.ts:69`, `open/wiring/__tests__/nexus-reader-seam.test.ts:71`, `open/wiring/__tests__/nexus-reader-seam.test.ts:86`, `open/wiring/__tests__/nexus-reader-seam.test.ts:93` | writer (fixture/input) |
| `open/wiring/memory.ts:319`, `open/wiring/memory.ts:321` | documentation |
| `open/wiring/memory.ts:50` | reader (binding) |
| `open/wiring/memory.ts:328` | writer (scope/value construction) |
| `open/wiring/nexus-reader-seam.ts:16`, `open/wiring/nexus-reader-seam.ts:36` | documentation |
| `open/wiring/nexus-reader-seam.ts:43` | reader |
| `open/wiring/nexus-reader-seam.ts:23` | reader (binding) |
| `reflection/__tests__/index.test.ts:131`, `reflection/__tests__/index.test.ts:186`, `reflection/__tests__/index.test.ts:222` | writer (fixture/input) |
| `reflection/corrections-store.ts:106`, `reflection/corrections-store.ts:169` | writer (scope/value construction) |
| `reflection/index.ts:157` | writer (scope/value construction) |
| `reminders/dispatcher.integration.test.ts:139` | reader (assertion) |
| `reminders/dispatcher.integration.test.ts:120`, `reminders/dispatcher.integration.test.ts:131` | writer (fixture/input) |
| `reminders/dispatcher.test.ts:130` | reader (assertion) |
| `reminders/dispatcher.test.ts:125` | writer (fixture/input) |
| `reminders/dispatcher.ts:336` | writer (scope/value construction) |
| `runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts:209`, `runtime/adapters/claude-code/persistent/__tests__/persistent-repl-substrate.test.ts:216` | writer (fixture/input) |
| `runtime/adapters/claude-code/persistent/context-reset.ts:44` | documentation |
| `runtime/adapters/claude-code/persistent/context-reset.ts:381` | writer (scope/value construction) |
| `runtime/adapters/claude-code/persistent/repl-session.ts:31` | documentation |
| `tests/integration/reminders-tab-and-push.open.test.ts:388`, `tests/integration/reminders-tab-and-push.open.test.ts:453` | reader (assertion) |
| `tools/registry.ts:81` | documentation |
| `trident/dispatch-holds.ts:216` | documentation |
| `trident/work-board-build-tool.ts:37` | reader (binding) |
| `trident/work-board-build-tool.ts:251`, `trident/work-board-build-tool.ts:343` | writer (scope/value construction) |
| `wire-types/app-ws-envelope.ts:618` | documentation |
| `wire-types/topic-id.ts:43` | client sentinel |
| `work-board/agent-tool.test.ts:292` | reader (assertion) |
| `work-board/agent-tool.test.ts:201` | writer (fixture/input) |
| `work-board/agent-tool.ts:234` | reader |
| `work-board/agent-tool.ts:34` | reader (binding) |
| `work-board/agent-tool.ts:298`, `work-board/agent-tool.ts:388`, `work-board/agent-tool.ts:450`, `work-board/agent-tool.ts:499`, `work-board/agent-tool.ts:583` | writer (scope/value construction) |
| `work-board/inline-activity.test.ts:223` | reader (assertion) |
| `work-board/inline-activity.test.ts:215`, `work-board/inline-activity.test.ts:230`, `work-board/inline-activity.test.ts:242`, `work-board/inline-activity.test.ts:259` | writer (fixture/input) |
| `work-board/spec-doc-service.test.ts:169` | reader (assertion) |
| `work-board/spec-doc-service.test.ts:167` | writer (fixture/input) |
| `work-board/store.test.ts:1229` | documentation (test name) |
| `work-board/store.test.ts:1233`, `work-board/store.test.ts:1234`, `work-board/store.test.ts:1235`, `work-board/store.test.ts:1236`, `work-board/store.test.ts:1237`, `work-board/store.test.ts:1238`, `work-board/store.test.ts:1239`, `work-board/store.test.ts:1243`, `work-board/store.test.ts:1244`, `work-board/store.test.ts:1245` | reader (assertion) |
| `work-board/store.test.ts:12` | reader (binding) |
| `work-board/store.test.ts:1252`, `work-board/store.test.ts:1255` | writer (fixture/input) |
| `work-board/store.ts:242`, `work-board/store.ts:270` | documentation |
| `work-board/store.ts:231`, `work-board/store.ts:260` | writer (scope definition) |

### Additional edges needed to map the reported failures

The original pattern misses `/general/` embedded in template URLs and constant-based consumers. A second search over the four files identified by the exact failing test names used `/general/|GENERAL_SCOPE|GENERAL_PROJECT_ID|httpScopeSegment|inspectorScopeKey|workBoardScopeKey`. Its positive control was `open/activity-inspector.test.ts:235` (`inspectorScopeKey(null)`). The five named failures occupy **four files**: both tab failures are in the mobile component test, not the web client.

| Failure | Writer / client sentinel | HTTP path / reader | Classification and result |
| --- | --- | --- | --- |
| Blocked-card completion | `trident/escalation-block.test.ts:482` writes owner-keyed card | `trident/escalation-block.test.ts:492`; `gateway/http/work-board-surface.ts:269`; `gateway/http/work-board-surface.ts:287` | HTTP segment `general` passes unchanged into the key mapper; `work-board/store.ts:265` only maps the reserved/empty values to the owner. Lookup selects a different board before the expected refusal. |
| Latched-dead start | `trident/liveness-death-e2e.test.ts:125` writes owner-keyed card | `trident/liveness-death-e2e.test.ts:138`; `trident/liveness-death-e2e.test.ts:141` | Same HTTP/key mismatch. HTTP assertion fails before the agent-tool assertions at `trident/liveness-death-e2e.test.ts:162`. This failure does not establish a broken orchestrator run lookup. |
| Rail sentinel request | `app/__tests__/general-tab-set.test.tsx:249`; `app/lib/general-scope.ts:65` | `app/__tests__/general-tab-set.test.tsx:135`; `app/__tests__/general-tab-set.test.tsx:257` | Client sentinel / HTTP mapper versus fixture reader: fake gateway rejects the reserved segment, while production resolver explicitly accepts it (`gateway/http/scope-segment.ts:6`). |
| Chat, Work, Docs order | `app/__tests__/general-tab-set.test.tsx:225` | `app/__tests__/general-tab-set.test.tsx:135`; `app/__tests__/general-tab-set.test.tsx:147`; `app/__tests__/general-tab-set.test.tsx:230` | Same rejected tabs fetch prevents reading the registry fixture. A tab-order change would not repair that boundary. |
| Activity onRecord | `open/activity-inspector.test.ts:261`; `open/activity-inspector.ts:52` | `open/activity-inspector.test.ts:264` | Writer supplies reserved scope, assertion expects former literal. This is a scope-value mismatch in the callback result, not evidence that the callback stopped firing. |

### Contract conflict and review ceiling

The current instruction declares the web three-spelling rule authoritative and forbids changing it. The web HTTP mapper returns `general` (`landing/chat-react/general-scope.ts:30`, `landing/chat-react/general-scope.ts:41`), but the branch implements reserved HTTP segments (`app/lib/general-scope.ts:65`, `gateway/http/scope-segment.ts:6`). Its existing acceptance test expressly keeps HTTP `general` and `~general` distinct (`gateway/http/scope-segment.test.ts:7`, `gateway/http/scope-segment.test.ts:9`) and the storage test protects the real project named `general` (`work-board/store.test.ts:1236`). Mapping HTTP `general` to General would restore the collision that this branch was built to remove. Retaining the reserved HTTP design requires revising the expressly protected web rule and mobile fake-gateway contract. Neither is an implementation-only choice under this brief.

The docs ownership decision is implicated too: the migration moves four components to the reserved directory (`gateway/docs-general-scope-migration.ts:7`, `gateway/docs-general-scope-migration.ts:26`, `gateway/docs-general-scope-migration.ts:27`, `gateway/docs-general-scope-migration.ts:37`), while the protected web header points to the former docs root (`landing/chat-react/general-scope.ts:16`). Web activity still reads the former scope (`landing/chat-react/activity-client.ts:145`, `landing/chat-react/activity-client.ts:149`) while the inspector writes the reserved scope (`open/activity-inspector.ts:52`). The affected contracts therefore span mobile clients/fixtures, web clients/fixtures, HTTP resolution, board storage, activity push/snapshot scope, and docs migration.

The earlier record's claim that reflection was the sole lagging producer is superseded by this enumeration. The review is looking at the subject: concrete HTTP fixtures and mobile client mappings disagree with branch-changed resolvers. Its description of a web rail failure and an orchestrator lookup failure was broader than the named tests show, as mapped above.

**BLOCKED: repeat finding after 3 rounds**, as reported in the task brief. The repeating class is incomplete General-boundary propagation. Under the standing round-three ceiling, no fourth implementation round was started. The actual disagreement is whether HTTP General remains `general` or retains the collision-proof reserved segment. A product ruling must reconcile that choice with the real project named `general`, existing docs ownership, and the protected tests before implementation resumes.

### Validation of the unchanged implementation

Ran `bun test trident/escalation-block.test.ts trident/liveness-death-e2e.test.ts open/activity-inspector.test.ts`: **91 pass, 3 fail**, reproducing the three named server failures. Ran `bun test app/__tests__/general-tab-set.test.tsx`: **2 pass, 2 fail**, reproducing both named mobile failures. No whole-directory or full-suite test command was run.

| Guard | Mutation | RED | Restored GREEN |
| --- | --- | --- | --- |
| No new guard in this investigation | Not performed; implementation unchanged at the review ceiling | Five existing failures reproduced | Not claimed |

### Deliberately not changed in this investigation

No runtime code, fixtures, assertions, spec decision, migration, or layer mapper was edited. No fallback lookup was introduced. This commit records enumeration and a blocked design review; it does not claim the five failures are fixed.

### Ruling applied (2026-09-15)

The owner resolved the round-three conflict: HTTP General is `~general`, and its docs root remains `Projects/~general/docs/`. The web three-layer contract still maps empty client scope to a nonempty HTTP segment; its updated header and constant explain the reserved spelling (`landing/chat-react/general-scope.ts:12`, `landing/chat-react/general-scope.ts:30`). The project validator excludes `~` (`channels/adapters/app-ws/envelope.ts:396`), so legal project `general` remains distinct by construction. This completes the selected issue direction; no existing decision in `SPEC.md` or a spec item changed.

The historical enumeration above was recovered from the previous lane's logged generation script and its retained 372-line grep output, because this checkout starts before that record-only commit. Its classifications and round-three conflict are preserved as historical evidence; the ruling supersedes that block, including its blocked status. The earlier claim of a sole lagging producer is likewise superseded by the enumeration and the web reader correction here.

The five failures occupy four files, as the retained table enumerates. The owner-keyed completion and start fixtures now request the reserved segment (`trident/escalation-block.test.ts:492`, `trident/liveness-death-e2e.test.ts:138`). The mobile gateway fake imports the production resolver instead of maintaining a second validator (`app/__tests__/general-tab-set.test.tsx:25`, `app/__tests__/general-tab-set.test.tsx:130`). Its two failing cases now exercise the accepted scope. The callback assertion matches the reserved value supplied to the writer (`open/activity-inspector.test.ts:261`, `open/activity-inspector.test.ts:264`).

The live web activity reader now derives its General key from the shared HTTP constant (`landing/chat-react/activity-client.ts:146`), matching the inspector's reserved key (`open/activity-inspector.ts:52`). Its test also pins the legal project `general` to its own activity endpoint (`landing/chat-react/__tests__/activity-client.test.ts:163`). Web Work Board URL expectations moved with the shared mapping (`landing/chat-react/__tests__/work-board-client.test.ts:154`). The docs mapping test explicitly pins both literals (`landing/chat-react/__tests__/general-docs-reachable.test.tsx:49`).

Continuous separation is maintained by the existing project validator, exact server resolver (`gateway/http/scope-segment.ts:6`), and storage key mapping (`work-board/store.ts:265`), independently of client correctness. The mobile fake delegates to that resolver. No new error, verdict, state, or refusal joins an outcome vocabulary: the existing scope and invalid-project handling remain in use. General docs migration and ownership remain as implemented (`gateway/docs-general-scope-migration.ts:26`, `gateway/docs-general-scope-migration.ts:27`, `gateway/docs-general-scope-migration.ts:37`).

### Ruling mutation evidence

| Guard / boundary | Printed mutation site and change | RED | Restored GREEN |
| --- | --- | --- | --- |
| HTTP board separation | `gateway/http/scope-segment.ts:6`: also map literal `general` to General | Populated project board returned `legacy` instead of `real project card`, at `gateway/http/work-board-surface.test.ts:923` | Same case passed |
| Web General HTTP mapping | `landing/chat-react/general-scope.ts:30`: restore literal `general` | Literal reserved-segment assertion failed at `landing/chat-react/__tests__/general-docs-reachable.test.tsx:50` | Same case passed |
| Activity reader scope | `landing/chat-react/activity-client.ts:146`: restore literal `general` | Both scope and named-project endpoint assertions failed at `landing/chat-react/__tests__/activity-client.test.ts:154` and `landing/chat-react/__tests__/activity-client.test.ts:163` | Both cases passed |
| Mobile fake scope acceptance | `app/__tests__/general-tab-set.test.tsx:130`: reject `~general` before resolving | Both General component cases failed; 2 pass / 2 fail | Full file 4 pass / 0 fail |

The board fixture populates both scopes before making HTTP requests (`gateway/http/work-board-surface.test.ts:913`), and asserts each board's contents. The activity mutation's first test filter mistakenly treated `+` as a regex operator and matched zero cases; that attempt is not counted as evidence. The corrected filter executed both cases and produced the RED/GREEN results above. All mutations were restored.

### Ruling validation and scope

The targeted server/web command passed 320 tests across these ten files, explicitly enumerated by command arguments: `trident/escalation-block.test.ts`, `trident/liveness-death-e2e.test.ts`, `open/activity-inspector.test.ts`, `gateway/http/scope-segment.test.ts`, `work-board/store.test.ts`, `gateway/http/work-board-surface.test.ts`, `landing/chat-react/__tests__/activity-client.test.ts`, `landing/chat-react/__tests__/general-docs-reachable.test.tsx`, `landing/chat-react/__tests__/work-board-client.test.ts`, and `landing/chat-react/__tests__/docs-client.test.ts`. The separate mobile command passed all four cases in `app/__tests__/general-tab-set.test.tsx`. The strengthened board test was rerun after ordering its content assertion before its metadata assertion and passed after restoration. Mobile tests emit React act warnings but pass their assertions.

A whole-tree source/Markdown phrase search checked `indistinguishable from the sentinel`, `surfaces key General on the literal`, `General buffer on the literal`, and `WHY THE STUB BELOW`, with positive control `The reserved HTTP path segment` matching `landing/chat-react/general-scope.ts:29`. The stale phrases had no remaining matches. A paired search for `sole lagging producer|All pass a nullable/reserved` finds the prior record and its correction; those historical entries stay with this explicit supersession.

Deliberately not built: no literal-HTTP alias, fallback read, project rename, storage remapping, or docs migration change. The protected resolver and storage assertions were not weakened. No whole-directory sweep or full test suite was run. Delivery is a local commit for orchestrator review.

Final local gates: `bash scripts/ci/typecheck-all.sh` passed all 51 configurations; `bash scripts/ci/lint.sh` passed all reported gates. `git diff --check` passed, and the record has exactly one top-level `## ` heading.
