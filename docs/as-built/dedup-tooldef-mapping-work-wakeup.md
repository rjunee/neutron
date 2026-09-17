## 2026-09-17 — work-wakeup uses the shared `builtinToolDefs` helper; the last inline ToolDef copy is gone

**Change.** `gateway/proactive/work-wakeup.ts` built the compose turn's `ToolDef[]` with its own inline `tool_names.map(...)` (the copy at the old line 738). It now calls `builtinToolDefs(deps.tool_names)` from `gateway/wiring/build-live-agent-turn.ts:352`, the helper #1113 introduced when it folded the trident acting-turn copy. Net: +2 / −7 lines, one file.

**Why.** Two independently written copies of one tool surface was #1112's shape: the dispatch requested the live surface while the prewarm hardcoded `[]`, the reuse guard respawned the child on the mismatch, and no worker could be created. This deletes the remaining copy so the wake surface and the acting-turn surface are the same expression.

**Import direction.** `gateway/proactive/` already imports from `../wiring/build-live-agent-turn.ts` (`terminal-build-wake.ts:10`, `terminal-deploy-wake.ts:4`); `build-live-agent-turn.ts` imports nothing from `gateway/proactive/` (`grep -n "^import" gateway/wiring/build-live-agent-turn.ts | grep proactive` → empty). No cycle.

**Proof.**

| leg | command | observed |
|---|---|---|
| green | `bun test gateway/proactive/__tests__/work-wakeup.test.ts` | 57 pass, 0 fail |
| mutant: `builtinToolDefs([])` | same | 56 pass, **1 fail** — `SAFETY — the compose turn presents the injected tool surface VERBATIM` at `work-wakeup.test.ts:213` (`expect(h.specs[0]!.tools.map((t) => t.name)).toEqual([...TOOLS])`) |
| restored | same | 57 pass, 0 fail |
| absence | `grep -n "tool_names.map" gateway/proactive/work-wakeup.ts` | empty; the same grep on `origin/main` finds line 738 |

The surface names are pinned by the test; the helper's `description` string differs from the deleted copy's (`live-agent read surface` vs `work-wakeup surface`) and nothing asserts on it.
