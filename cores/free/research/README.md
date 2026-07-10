# @neutron/research-core (v0.2.0)

Tier 1 free Research Core — the Atlas-shape research workflow productized for every Neutron instance.

## Status

**v0.2.0 (Research Core S1, 2026-05-21)** — chat-command surface, per-project storage, claim-evidence-citation triples, sources-cited invariant, in-process Haiku-4.5 sub-agent for `/research deep`, web-browse with allow-list, lex/vec hybrid search over prior briefs, P5.3 launcher tile + `app_tab` UI component, production-composer reachability guard.

## Architecture

| Layer | Module | Role |
|-------|--------|------|
| Manifest | `src/manifest.ts` | Locked constants (tool names, capability strings, sub-agent budgets) |
| Storage | `src/research-store.ts` + `src/claim-store.ts` | Per-project SQLite at `<OWNER_HOME>/Projects/<project_id>/research/research.db` |
| Resolver | `src/store-resolver.ts` | Lazy per-project handle resolution with init-promise dedup |
| Migrations | `migrations/0001_research_claims.sql` | Forward-only schema (research_tasks + research_claims + research_sub_agent_runs + research_briefs_fts + research_meta sentinel) |
| Orchestrator | `src/research-orchestrator.ts` | Parse-once-retry-once + sources-cited assertion + claim insertion |
| Substrate port | `src/backend.ts:ResearchSubstrate` | Production wires runtime.Substrate; tests use `buildCannedResearchSubstrate` |
| Sub-agent | `src/sub-agent.ts` + `src/sub-agent-prompt.ts` | Atlas-shape Haiku-4.5 harness for `/research deep` |
| Web search | `src/web-search.ts` | Tavily provider (paid, optional); pluggable interface |
| Web fetch | `src/web-fetch.ts` + `src/web-fetch-allowlist.ts` | RFC-1918 / loopback / link-local / file:// / non-allowlisted public domain rejected |
| Vault search | `src/vault-search.ts` | Lex+vec hybrid over `research_briefs_fts` |
| Chat commands | `src/chat-commands.ts` + `src/chat-bridge.ts` | `/research <topic>`, `/research deep`, `/research list`, `/research find` |
| MCP tools | `src/tools.ts` + `src/mcp-tools-extra.ts` | 8 capability-guarded tools |
| Markdown render | `src/render-markdown.ts` | Deterministic file output |
| UI | `src/ui/launcher-icon.ts` + `src/ui/app-tab-surface.ts` | P5.3 launcher binding + app_tab surface |

## Sources-cited invariant (the headline contract)

Every claim row MUST EITHER carry a non-empty `citation` (URL, file path, DOI), OR be tagged `confidence:'unverified'`. No third path.

```ts
import { assertSourcesCited, SourcesCitedViolationError } from '@neutron/research-core'

// Throws SourcesCitedViolationError on the first claim missing both citation + unverified tag.
// Empty claim arrays ALSO fail — every brief must carry at least one cited-or-unverified claim.
const count = assertSourcesCited(task_id, claims)
```

The orchestrator's flow:

1. Insert pending task row.
2. Set running.
3. Call substrate (or sub-agent for `/research deep`) → raw text.
4. `extractJson(text)` → unknown.
5. `validateResearchBrief(unknown)` → typed brief + claims.
6. **`assertSourcesCited(task_id, claims)` → throws on violation.**
7. On success: `claimStore.insertClaim(...)` × N + `setCompleted(brief)`.
8. On any violation: retry-once with a sources-cited-specific rider, then `setFailed(task_id, <typed error message>)`.

This contract enforces CLAUDE.md / SOUL.md operating principle #9 ("No fabricated analysis") as code, not docs.

## SDK capability — `network:browse`

Declared in the single manifest source `cores/sdk/manifest.ts:KNOWN_CAPABILITIES` (X3 — one manifest contract; the former `core-sdk` closed union + JSON-schema mirror were folded in and deleted).

Semantics: declaring `network:browse` implies `network:external` and promises the Core enforces a per-Core domain allow-list. The runtime does NOT enforce the allow-list itself; the Core is the source of truth. See `src/web-fetch.ts` for the reference enforcer:

- **Unconditionally blocked**: RFC-1918 (10.x / 172.16-31.x / 192.168.x), loopback (127.x), link-local (169.254.x — incl. cloud metadata at 169.254.169.254), IPv6 ULA / link-local, DNS-rebinding hostnames (`xip.io` / `nip.io` / `sslip.io`), `file://` / `ftp://` / `data:` / `javascript:` / chrome-extension://.
- **Per-Core allow-list**: configurable; v1 ships defaults at `web-fetch-allowlist.ts`.
- **Redirect-follow safety**: blocked / non-allowlisted destinations refused even via 302.
- **Size cap**: 5 MB default; **Timeout**: 30 s default; **Content-type**: only text/* + application/json-shape.

## MCP tools

| Tool | Capability | Description |
|------|-----------|-------------|
| `research_start` | write | Synchronous standard-depth synthesis pass |
| `research_status` | read | Look up task lifecycle state |
| `research_fetch` | read | Fetch the completed brief |
| `research_deep` | write + network:browse + agent:dispatch_subagent | Haiku-4.5 sub-agent run |
| `research_list` | read | Recent briefs for a project |
| `research_find` | read | Lex+vec hybrid search |
| `research_cite` | write | Add or update a claim's citation |
| `research_claims_list` | read | All claims for a task |

## Chat-command surface

```
/research <topic>            — synchronous standard-depth brief
/research deep <topic>       — Haiku-4.5 sub-agent (web browse + vault search), ~5min budget
/research list               — recent briefs for this project
/research find <query>       — lex+vec hybrid search over prior briefs
/research help               — surface cheatsheet
```

## Production wiring

The gateway's `gateway/index.ts` boot path:

1. Builds a per-project `ResearchStoreResolver` keyed on `owner_home`.
2. Constructs a `PerTenantConcurrencyGate` (cap 2 by default).
3. Builds the project-scoped backend via `buildProjectResearchOrchestrator(...)`.
4. Builds the chat-command filter via `createResearchChatCommandFilter(...)`.
5. Threads the filter into the `buildChainedChatCommandFilter(...)` chain passed to `createAppWsSurface`.

The production-composer reachability guard at `gateway/__tests__/research-core-production-composer.test.ts` asserts the chat-command filter passed to `createAppWsSurface` is the SAME instance the boot path constructs (closes the PR #252-style "filter built but not wired" anti-pattern).

## Testing

```
bun test cores/free/research --max-concurrency=2
```

Tests use the bundled stubs (`buildCannedResearchSubstrate`, `buildCannedSubAgentDispatcher`, `buildCannedWebSearchProvider`) so the suite runs without network and never makes a real LLM call.

## Out of scope (deferred to S2)

Per `docs/plans/research-core-tier1-brief.md § 9`: auto-publishing to Telegram / chat; Tier 2 paid `@neutron-paid/research-pro`; domain-specific sub-agents; Sentinel-style in-Core verification; inter-Core tunnels to Notes / Tasks; LLM-driven claim extraction from arbitrary text; scheduled research (Reminders × Research); real-time progress streaming during a long deep run; offline-citation cache.

## Cross-refs

- `docs/plans/research-core-tier1-brief.md` — the locked sprint brief
- `docs/research/neutron-cores-marketplace-split-2026-05-17.md` — two-tier Cores model
- `docs/engineering-plan.md § B.P3` — research Core in the original plan
- `cores/sdk/SDK-CONTRACT.md` — capability semantics
- `cores/runtime/` — install / capability gate / audit log
