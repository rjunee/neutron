## 2026-09-16 — recovery logging cannot change the reported outcome

### What changed

The service now converts the injected callback into one contained logger at the factory boundary (`reminders/ritual-registration.ts:425-433`). That wrapper invokes the callback inside `try`, normalizes its result through `Promise.resolve`, and passes the result to the repository's silent late-settle observer; all service logging therefore uses the same boundary. The render recovery continues to report the malformed row and return `null` (`reminders/ritual-registration.ts:786-794`), leaving `reraisePending` to expire that row while later rows continue.

The callback contract now returns `unknown` (`reminders/ritual-registration.ts:379-389`). This deliberately describes async and JavaScript callers instead of claiming a `void` callback excludes them. The internal wrapper still returns `void` (`reminders/ritual-registration.ts:426-433`).

The test harness accepts the same callback contract (`reminders/ritual-registration.test.ts:82-129`). Existing coverage proves a healthy logger receives the render-failure message and the healthy row still emits (`reminders/ritual-registration.test.ts:1144-1180`); synchronous-throw coverage preserves the sweep outcome (`reminders/ritual-registration.test.ts:1181-1200`); new rejected-promise coverage proves the sweep survives the rejection while the bad row expires and the healthy row remains pending and emits (`reminders/ritual-registration.test.ts:1201-1221`).

A rejected logger promise is **neutralized, not observed.** `neutralizeAbandonedSettle` attaches a handler so V8 cannot report an unhandled rejection, and its own docblock says it does so "WITHOUT logging or counting" (`logger/fire-and-forget.ts:167-188`). Nothing anywhere records that the injected logger failed. That is a deliberate limit of this change, not an oversight: the only channel this code has for saying so is the very callback that just failed. The alternative — routing it through `fireAndForget`, which logs and counts via the system logger rather than the injected one — is a real option and is deliberately NOT taken here, because it widens the change beyond the issue's acceptance. It is filed separately rather than smuggled in.

### Decisions and continuous invariant

I chose one factory-bound runtime wrapper over narrowing the type. TypeScript permits an async function where a void-returning callback is expected, and JavaScript callers have no static contract, so runtime containment is required. A single wrapper protects every logger use **of the registration service**; those call sites were enumerated with `rg -n "\\blog\\(" reminders/ritual-registration.ts` — lines 793, 798, 886, 962, 999, 1007, 1031, 1065, 1068, 1223, 1233 and 1240 — all bound to the wrapper at lines 425-433.

**Scope limit, stated rather than implied:** this is not every injected logger in the file. A second, separately injected `log?: (msg: string) => void` remains at `reminders/ritual-registration.ts:1213` and does **not** pass through this wrapper, so an async logger injected there is still uncontained. Sibling modules carry the same unnarrowed shape — `reminders/context.ts:34`, `reminders/dispatcher.ts:325`, `reminders/bundled-rituals.ts:154`, `reminders/bundled-ritual-enable.ts:138` — and are untouched by this change. Containing them is the same edit repeated and belongs in its own change; claiming them here would be the false-coverage failure this record exists to avoid.

The wrapper at `reminders/ritual-registration.ts:425-433` continuously maintains the invariant and does not depend on the failing callback remaining operational. No new error, verdict, state, or refusal is introduced, so no outcome taxonomy changes: the existing approval lifecycle still receives `null` from the render callback (`reminders/ritual-registration.ts:786-794`), and the tests observe the malformed approval as `expired` (`reminders/ritual-registration.test.ts:1196-1199`, `reminders/ritual-registration.test.ts:1216-1220`).

### Mutation table

| Requirement and guard | Compiling mutation printed before run | Focused command | Red result | Restored result |
|---|---|---|---|---|
| A rejected promise cannot become an unhandled rejection, at `reminders/ritual-registration.ts:428` | Replaced `neutralizeAbandonedSettle(...)` with bare `void Promise.resolve(rawLog(msg))` on line 428 | `bun test reminders/ritual-registration.test.ts -t 'a rejecting async render-failure logger cannot change sweep recovery'` | 0 pass / 1 fail: `async logger unavailable` surfaced as unhandled | Included in restored focused run: 3 pass / 0 fail |
| Synchronous throws are contained at `reminders/ritual-registration.ts:427-432` | Removed the `try`/`catch`, leaving direct invocation on line 427 | `bun test reminders/ritual-registration.test.ts -t 'a throwing render-failure logger cannot change sweep recovery'` | 0 pass / 1 fail: sweep rejected instead of resolving | Included in restored focused run: 3 pass / 0 fail |
| Healthy loggers receive the message at `reminders/ritual-registration.ts:428` | Replaced `rawLog(msg)` with `undefined` on line 428 | `bun test reminders/ritual-registration.test.ts -t 'a row whose render throws is logged with its id and cause'` | 0 pass / 1 fail: expected one render line, received zero | Included in restored focused run: 3 pass / 0 fail |

The restored focused command matched all three logger regressions and passed 3 / 3. `bun test reminders/ritual-registration.test.ts` passed 45 / 45; `bunx tsc --noEmit -p reminders/tsconfig.json` passed; `scripts/ci/typecheck-all.sh` passed all 51 TypeScript projects; `scripts/ci/lint.sh` passed every reported gate; and `git diff --check` passed. The leak gate reported zero findings from the rules it ran but exited 3 because its two external owner-PII denylist checks were unavailable, so this is not recorded as a clean leak-gate result.

### Evidence sweep and scope

The issue citations were re-read against the branch: the public callback is at `reminders/ritual-registration.ts:379-389`, the factory boundary is at `reminders/ritual-registration.ts:412-433`, and the render recovery is at `reminders/ritual-registration.ts:751-801`. The original synchronous test remains at `reminders/ritual-registration.test.ts:1181-1200`; the new asynchronous test follows it at lines 1201-1221.

A whole-tree distinctive-phrase search with `rg -n "ritual approval render failed|broken logger|throwing render-failure logger" . --glob '!node_modules/**'` positively found the production report, regressions, and the earlier historical record at `docs/as-built/ritual-approval-silent-drop.md:18`. That historical record remains because it describes the prior change accurately; this record supersedes only the incomplete review-branch shard.

### Deliberately not done

No call-site-only second guard, feature flag, parallel logging path, or new outcome was added. `SPEC.md` and spec items were not changed because this review fix preserves the existing product decision and approval lifecycle. The full test suite was not run, per lane instructions; verification was scoped to the touched test file plus repository type and lint gates.
