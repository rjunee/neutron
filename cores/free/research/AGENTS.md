# AGENTS.md — cores/free/research

This directory is the Tier 1 free Research Core (`@neutron/research-core`).

## v0.2.0 (Research Core S1, 2026-05-21)

Surfaces eight MCP tools (3 legacy + 5 new), a chat-command surface
(`/research <topic>` / `/research deep <topic>` / `/research list` /
`/research find <q>`), an in-process Haiku-4.5 sub-agent harness for
`/research deep`, web-search + web-fetch capability with a per-Core
allow-list, lex/vec hybrid search over prior briefs, claim-evidence-
citation triple data model, and the sources-cited invariant.

Storage: per-project SQLite sidecars at
`<OWNER_HOME>/Projects/<project_id>/research/research.db` via
`ResearchStoreResolver` (lazy-init + instance/project mismatch defence
+ cached handles). Schema in `migrations/0001_research_claims.sql`.

The Core is an Atlas-shape Core that wraps an LLM-driven synthesis
pipeline AND an in-process sub-agent harness for deep research, and
emits a structured brief (`topic` / `key_findings[]` / `sources[]` /
`confidence_level` / `recommendations[]` / `claims[]` triple list).

## Sources-cited invariant (the headline contract)

Every claim row MUST EITHER carry a non-empty `citation` (URL, file
path, DOI), OR be tagged `confidence:'unverified'`. No third path.
`assertSourcesCited(...)` is the predicate the orchestrator calls
BEFORE `setCompleted`. Empty claim arrays also fail. The retry-once
path includes a sources-cited-specific rider. Enforces CLAUDE.md /
SOUL.md operating principle #9 ("No fabricated analysis") as code.

## It must NOT:

- Make real LLM calls in tests. Every test goes through a stub
  `ResearchSubstrate` + canned `RuntimeSubAgentDispatcher` +
  `CannedWebSearchProvider` that return canned JSON / hits.
- Hit the live web in tests. The web-fetch wrapper is exercised
  via injected `fetcher` (typeof fetch); the web-search wrapper via
  `buildCannedWebSearchProvider`.
- Import from external sources or any external memory package. The Atlas system
  prompt is re-implemented IN-TREE at `src/sub-agent-prompt.ts`.
- Reach into other Cores' namespaces. Storage is per-project sidecar;
  the manifest declares only `read:/write:research_core.db` for the
  sidecar, plus `network:browse` + `agent:dispatch_subagent` for the
  deep-research path.
- Bypass the sources-cited invariant. Every code path that writes a
  brief MUST call `assertSourcesCited(...)` before `setCompleted`.
- Make uncited claims past the substrate/sub-agent boundary. The
  substrate prompt requires `claims[]` with the sources-cited rider;
  if the model emits a violation, the orchestrator retries with a
  rider then fails the task.

## Why this package is @neutron/research-core (with `-core` suffix)

The bare `research` name has no engine sibling today, but every other
Tier 1 free Core uses the `-core` suffix when the engine workspace
already owns or might own the unsuffixed name in a future sprint.

Cross-refs:

- `docs/plans/research-core-tier1-brief.md` — S1 sprint brief (the
  locked spec for this directory).
- `SPEC.md § Phases→Steps` — Tier 1 Cores buildout
- `cores/sdk/SDK-CONTRACT.md` — author-facing API (incl. the new
  `network:browse` capability semantics)
- `cores/runtime/` — install / capability gating / audit log
- `runtime/substrate.ts` + `runtime/sub-agent.ts` — the runtime
  dispatchers the Core's port wraps in production
