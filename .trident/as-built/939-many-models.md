## 2026-09-15 — Configured model access for review and project chat (#939)

### Delivered and evidence

- Shared row parsing lives at `runtime/configured-models.ts:10`; the review registry
  delegates to it at `trident/model-tiers.ts:229`. The existing review request path
  remains `trident/api-review.ts:24`. Built-in tier names reserve their namespace in the shared parser (`runtime/configured-models.ts:16`).
- `NEUTRON_PROJECT_MODELS` maps project IDs to configured tiers
  (`runtime/configured-models.ts:41`). Open validates the map at boot
  (`open/composer.ts:852`) and passes its environment and project-bound tool resolver
  into dispatch (`open/wiring/substrates.ts:127`,
  `gateway/wiring/build-llm-call-substrate.ts:699`). Explicit API routes precede
  the ordinary harness hierarchy; the latter's settings do not edit the route map.
- The chat-completions adapter streams text, checks model attribution, handles
  tool results and checks cancellation before executing tools
  (`runtime/adapters/configured-chat/index.ts:43`, `:69`, `:105`, `:115`).
  The invariant is maintained on every dispatch and stream, without requiring
  the provider to admit an error. Attribution checks the returned model declaration;
  it cannot independently attest which model a remote service actually executed.
- Live chat rehydrates its existing recent context each turn, avoids warm-harness
  injection, records the selected tier in the effective prompt spec, and names a
  failed tier in the user bubble (`gateway/wiring/build-live-agent-turn.ts:1009`,
  `:1517`, `:1651`, `:1772`, `:1820`). The production callback is at
  `open/composer.ts:5677`. This reuses the bounded recent-history context, not an
  unlimited remote transcript.
- Build dispatch excludes configured chat routes (`open/wiring/substrates.ts:165`).
  The positive native-build control and API request-count assertion are at
  `open/__tests__/open-wiring-substrates.test.ts:1140`.
- The identity registry entry moved with the credential-name regex
  (`tests/integration/identity-env-readers-registry.test.ts:400`). This is a
  conservative regex candidate registration, not a new identity-environment read.

### Decisions and outcome vocabulary

Reuse the already implemented review wire protocol instead of claiming an
unmeasured external router integration. One shared row supplies endpoint, exact
model ID and credential reference. The explicit project map avoids a database
migration or a provider enum edit for every model. The supported API backend and
selection precedence are recorded in the SPEC Decisions Log dated 2026-09-15 and
`docs/spec-items/configured-models-for-review-and-chat.md`.

Chat refusals join the existing `Event.kind = error` vocabulary with
`retryable: false` (`runtime/adapters/configured-chat/index.ts:123`). Configuration,
missing credentials, non-OK HTTP responses and cancellation use the existing
`spawn_configuration`, `no_credentials`, `http_status`, and `aborted` classes.
Their defaults are nonretryable (`runtime/errors.ts:105`, `:128`, `:136`, `:140`).
Malformed streams and tool failures have no more specific existing code; their
consumer classification is explicitly `unknown` (`runtime/errors.ts:77`), while
the emitted retryability remains false. The request loop keeps the configured model (`runtime/adapters/configured-chat/index.ts:46`).
The search `rg -n "rotate|model: row.model" runtime/adapters/configured-chat/index.ts`
returned the fixed model assignment at line 46 as its positive control and no
rotation match in that file. Review
refusals retain the existing blocking `deferred` result (`trident/api-review.ts:16`).

### Mutation proof

Each listed mutation was printed at its actual source line, run against the
focused test file, and restored. All 30 produced assertion failures; all restored
suites passed. The table is enumerated from the 22 adapter/routing mutations and
7 shared-parser/Open-wiring mutations plus one boot-validation mutation executed for this change.

One initial usage mutation survived: its fixture had no finish event, so the later
completeness guard refused it even without usage validation. The mutation landed
and ran, but could not change the final result. The corrected fixture includes a
valid completed answer followed by malformed usage. Removing usage validation
then produced RED, and restoring it produced GREEN.

| Guard / source | Mutation | Test that went RED | Restored |
|---|---|---|---|
| unknown tier: `runtime/adapters/configured-chat/index.ts:27` | Select first configured row regardless of tier | unknown model refuses without contacting a provider | GREEN |
| credential: `runtime/adapters/configured-chat/index.ts:34` | Remove guard | missing credential refuses without contacting a provider | GREEN |
| round limit: `runtime/adapters/configured-chat/index.ts:41` | Remove guard | tool round limit stops requests without model fallback | GREEN |
| HTTP status: `runtime/adapters/configured-chat/index.ts:58` | Remove guard | HTTP error cannot turn a valid completion body into success | GREEN |
| model attribution: `runtime/adapters/configured-chat/index.ts:69` | Remove guard | refuses wrong model by model name before tools execute | GREEN |
| choices shape: `runtime/adapters/configured-chat/index.ts:71` | Remove guard | refuses multiple choices by model name before tools execute | GREEN |
| usage shape: `runtime/adapters/configured-chat/index.ts:74` | Remove guard | refuses bad usage by model name before tools execute | GREEN |
| delta ordering: `runtime/adapters/configured-chat/index.ts:80` | Remove guard | refuses late delta by model name before tools execute | GREEN |
| content type: `runtime/adapters/configured-chat/index.ts:83` | Remove guard | refuses invalid content by model name before tools execute | GREEN |
| tool index: `runtime/adapters/configured-chat/index.ts:88` | Remove guard | refuses invalid call index by model name before tools execute | GREEN |
| complete stream: `runtime/adapters/configured-chat/index.ts:97` | Remove guard | refuses missing DONE by model name before tools execute | GREEN |
| tool declaration and ids: `runtime/adapters/configured-chat/index.ts:106` | Remove guard | refuses undeclared tool by model name before tools execute | GREEN |
| nonempty batch: `runtime/adapters/configured-chat/index.ts:110` | Remove guard | refuses empty tool batch by model name before tools execute | GREEN |
| cancel tool: `runtime/adapters/configured-chat/index.ts:115` | Remove guard | cancellation before tool dispatch prevents side effects | GREEN |
| SSE bound: `runtime/adapters/configured-chat/index.ts:144` | Remove guard | oversized unfinished SSE line refuses | GREEN |
| project config shape: `runtime/configured-models.ts:46` | Replace shape condition with false | invalid project mapping [] refuses | GREEN |
| project own key: `runtime/configured-models.ts:50` | Remove own-property check | project routes are scoped, live and keep an unknown tier selected for refusal | GREEN |
| tool resolver binding: `gateway/wiring/build-llm-call-substrate.ts:709` | Remove guard | configured chat refuses an advertised tool manifest without a resolver | GREEN |
| cold on configured turn: `gateway/wiring/build-live-agent-turn.ts:1518` | Remove guard | configured chat rehydrates every turn and restores cold context when returning to a harness | GREEN |
| no warm mark for stateless turn: `gateway/wiring/build-live-agent-turn.ts:1820` | Allow warm mark after configured turn | configured chat rehydrates every turn and restores cold context when returning to a harness | GREEN |
| no warm injection: `gateway/wiring/build-live-agent-turn.ts:1009` | Remove guard | configured chat queues overlapping input instead of injecting into a warm harness | GREEN |
| named chat refusal: `gateway/wiring/build-live-agent-turn.ts:1772` | Replace configured-tier condition with false | configured chat failure names the selected tier in the user bubble | GREEN |
| chat routes excluded from builds: `open/wiring/substrates.ts:165` | Remove guard | configured project chat boots without either built-in key and binds tools only for live chat | GREEN |
| configured startup without built-in key: `open/wiring/substrates.ts:172` | Remove configured-route availability | configured project chat boots without either built-in key and binds tools only for live chat | GREEN |
| tool trust class: `open/wiring/substrates.ts:130` | Expose manifest in toolless phase | configured project chat boots without either built-in key and binds tools only for live chat | GREEN |
| shared row shape: `runtime/configured-models.ts:21` | Remove guard | configuration refuses null row | GREEN |
| shared required fields: `runtime/configured-models.ts:23` | Remove guard | configuration refuses missing model | GREEN |
| shared duplicate and credential references: `runtime/configured-models.ts:28` | Remove guard | configuration refuses duplicate tier | GREEN |
| shared endpoint constraints: `runtime/configured-models.ts:31` | Remove guard | configuration refuses unsafe endpoint protocol | GREEN |
| Boot validation: `open/composer.ts:852` | Remove project-map validation at startup | Open boot refuses malformed configured project routes | GREEN |

### Validation

- 232 tests passed across these eight explicitly selected files:
  `runtime/adapters/configured-chat/index.test.ts`,
  `trident/__tests__/api-review.test.ts`, `trident/__tests__/model-tiers.test.ts`,
  `open/__tests__/open-wiring-substrates.test.ts`,
  `gateway/wiring/__tests__/build-live-agent-turn-context-reset.test.ts`,
  `gateway/wiring/__tests__/build-llm-call-substrate-provider.test.ts`,
  `tests/integration/identity-env-readers-registry.test.ts`,
  `scripts/__tests__/spec-items-index.test.ts`.
- Root `bunx tsc --noEmit`, Trident `bunx tsc --noEmit -p trident/tsconfig.json`,
  and `bash scripts/ci/lint.sh` passed. Root package scripts do not declare
  `typecheck` (`package.json:57`); `rg -n '"typecheck"|"scripts"|"test"' package.json`
  returned the known scripts/test controls at lines 57 and 60. The compiler
  commands are the local checks.
- `git diff --check` passed. The migration-diff query
  `git diff --name-only HEAD -- migrations runtime/configured-models.ts` returned
  only the known changed runtime file as its positive control.

The public-tree leak check exited 3 (INCOMPLETE): zero findings from the rules
that ran, but its private PII denylist is unavailable. The tree and commit-message
PII rules could not run; this is not a clean PII result.

### Deliberately not delivered and remaining verification

No router installation, new harness, database migration, model-picker UI or
change to build orchestration was intended. Project selection is configuration
controlled; direct chat uses the exact configured endpoint's protocol. Fixtures
exercise Kimi, GLM and DeepSeek labels, not those live services.

Live provider credentials were not supplied and this lane forbids network use.
Live streaming/tool compatibility, exact model-ID behavior, and codex-router's
interactive/headless operation remain unchecked acceptance items. Do not close
#939 on fixture evidence alone. The staged shard location follows the explicit
build-lane task, overriding the general docs/as-built location rule.
