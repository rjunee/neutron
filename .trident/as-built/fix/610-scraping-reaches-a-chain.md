## Issue 610 — scraping reaches the production chain

### What changed

The Open composition root now builds the scraping Core's manifest-gated secret accessor and production chat wiring (`gateway/cores/mount-open-cores.ts:418-430`), then adds that filter to the free-Core command chain (`gateway/cores/mount-open-cores.ts:492-508`). The Core's wiring contract now accurately distinguishes the chat backend from the independently built MCP backend while documenting their shared guarded credential path (`cores/free/scraping/src/wiring-production.ts:4-15`).

`/scrape` moved from the known-unreachable taxonomy to the live reachability inventory (`open/__tests__/reachability-inventory.ts:157-166`). The live vocabulary treats a missing claim as a lost owner capability by default (`open/__tests__/reachability.test.ts:304-318`).

### Decisions

The chat path uses `buildSecretsAccessor` over the scraping manifest and the already composed `SecretsStore` (`gateway/cores/mount-open-cores.ts:421-429`). This preserves the Core's declared-secret guard and resolves the same per-instance Apify credential as installation without adding a second configuration path.

The probe is bare `/scrape`: it returns static help before credential or network access (`open/__tests__/reachability-inventory.ts:162-165`), making the production-socket reachability check deterministic on a fresh install.

The reachability inventory had caught this defect rather than missing it: its known-unreachable list was actively typed through the socket (`open/__tests__/reachability.test.ts:321-334`). The gap was the deliberately broken classification, which this change promotes to the live list.

### Tests and mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| Production composer claims `/scrape` (`gateway/cores/__tests__/mount-open-cores.test.ts:168-173`) | Removed `scrapingWiring.chat_command_filter` from the chain; printed chain ended at research (`gateway/cores/mount-open-cores.ts:503-507`) | Focused test received `null` at line 172 | Restored chain member at `gateway/cores/mount-open-cores.ts:507`; focused test passed |

The complete focused files passed together: `gateway/cores/__tests__/mount-open-cores.test.ts` and `open/__tests__/reachability-inventory-complete.test.ts` (23 pass, 0 fail). TypeScript passed for `gateway`, `open`, and `cores/free/scraping`. `scripts/ci/lint.sh` passed every gate.

The production-socket test was attempted twice. Both runs composed and installed the scraping Core, then the local runtime refused its ephemeral listener at `open/__tests__/reachability.test.ts:120-124` with `EADDRINUSE`; no command was probed, which its completeness assertion correctly reported at `open/__tests__/reachability.test.ts:367-372`. This is recorded as an environment failure, not a green reachability result.

### Enumeration and deliberate limits

The sibling audit enumerated every non-test TypeScript definition and call matching `buildProduction[A-Za-z]+CoreWiring`. It found two definitions: scraping (`cores/free/scraping/src/wiring-production.ts:62`) and research (`cores/free/research/src/wiring-production.ts:98`). As a positive control, the same call-pattern search found research composed at `gateway/cores/mount-open-cores.ts:398`; it also found scraping at line 421 after this change. No other builder in that named production-wiring family has the zero-call-site shape.

Only scraping was wired. The stale sentence in `docs/SYSTEM-OVERVIEW.md:8707` was identified by a tree-wide distinctive-phrase search but deliberately left unchanged because the task's path scope excludes that document. No feature flag, alternate path, spec decision, or unrelated Core change was added.
