## Issue 611 — mobile project route parameters track project switches

### What changed

The root stack now registers the static `projects` navigator at `app/app/_layout.tsx:223`, and `app/app/projects/_layout.tsx:3` introduces the nested stack whose `[id]` screen is registered at `app/app/projects/_layout.tsx:6`. This makes the project identifier its own dynamic route node instead of leaving it embedded in the composite root name `projects/[id]`.

The project shell now consumes that route parameter directly at `app/app/projects/[id]/_layout.tsx:152`. The chat and waypoint routes use the same authority at `app/app/projects/[id]/chat.tsx:26` and `app/app/projects/[id]/index.tsx:46`; the superseded pathname parser and its dedicated tests were removed. The waypoint still latches the scope of an in-flight last-tab lookup at `app/app/projects/[id]/index.tsx:48`, which prevents an asynchronous handoff from being retargeted without creating a second source for project identity.

### Root cause and consumer enumeration

The cause was navigator structure, not a stale closure or a read-site memo: without `app/app/projects/_layout.tsx`, Expo Router hoisted the directory family into the root route name `projects/[id]`. Its dynamic-name matcher recognizes a route only when the whole node name has bracket form, so project-to-project navigation did not diverge at the node carrying `id`. The old composite registration was at `app/app/_layout.tsx:223`; the new two-level registrations are at `app/app/_layout.tsx:223` and `app/app/projects/_layout.tsx:6`.

Consumers were completely enumerated with `rg -n 'useLocalSearchParams' 'app/app/projects/[id]' -g '*.tsx'`; the known match at `app/app/projects/[id]/_layout.tsx:152` was the positive control. Eleven matched route files consume `id`: `_layout.tsx:152`, `backups.tsx:87`, `chat.tsx:26`, `cores/dtc-analytics.tsx:167`, `docs.tsx:93`, `index.tsx:46`, `launcher.tsx:64`, `reminders.tsx:59`, `settings.tsx:54`, `tasks.tsx:57`, and `workboard.tsx:90`. `cores/[slug].tsx:38` was the only matched invocation that consumes child/query parameters but not `id`.

The route family has no separate outcome taxonomy: this change introduces no new error, verdict, state, or refusal. Continuous maintenance comes from the file-based navigator boundary plus the structural assertions at `app/__tests__/project-route-param-tracks-switch.test.ts:18` and `app/__tests__/mobile-entry-route.test.ts:212`; it does not depend on a failed project screen continuing to run.

### Tests and mutation evidence

Before the implementation, `bun test app/__tests__/project-route-param-tracks-switch.test.ts` was red in both cases because the `projects` node did not exist. The regression test asserts the dynamic-node structure at `app/__tests__/project-route-param-tracks-switch.test.ts:18`, then checks both `willow → harbor` and `harbor → willow` at `app/__tests__/project-route-param-tracks-switch.test.ts:25`.

| Guard | Mutation | Red evidence | Restored evidence |
|---|---|---|---|
| Nested dynamic registration | Changed `app/app/projects/_layout.tsx:6` from `[id]` to `id`; the printed mutated line showed `<Stack.Screen name="id" />` | New route-param test: 1 failed, 1 passed | Touched tests: 38 passed, 0 failed |
| Root navigator registration | Changed `app/app/_layout.tsx:223` from `projects` to `projects/[id]`; the printed mutated line showed the composite name | Mobile entry test: 1 failed, 14 passed | Touched tests: 38 passed, 0 failed |

Local verification:

- `bun test` with the five touched test files: 38 passed, 0 failed.
- `bun run typecheck`: green.
- `EXPO_NO_TELEMETRY=1 bun run lint`: green with 21 pre-existing warnings and no errors. The pre-existing unescaped apostrophe at `app/app/projects/[id]/cores/dtc-analytics.tsx:279` was encoded so the required repository lint command could complete successfully.

### Decisions and deliberate exclusions

The structural route fix replaces the pathname-derived compatibility path; it does not retain a feature flag or parallel project-id authority. The former pathname-parser test and the harness mode that erased params were removed because they asserted the deleted workaround, while the existing end-to-end switch tests remain and pass.

No files under `app/lib/chat-core/` were changed. No product decision changed, so `SPEC.md` and the spec-item queue were left untouched. Device verification was not performed in this build lane; the structural regression and existing in-process mobile switch coverage are the local evidence supplied for review.
