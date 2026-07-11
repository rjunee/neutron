/**
 * @neutronai/app — D7 docs-hook invariant guards.
 *
 * Convention note (matching `docs-drill.test.ts`,
 * `range-anchor-highlight.test.ts`, `comments-side-pane.test.tsx`): the
 * app's bun:test suite does NOT mount React Native components and has
 * no hook-render harness. The docs tab's hook orchestration is verified
 * end-to-end by the agent-browser smoke pass.
 *
 * This file is the executable safety net for the two invariants the D7
 * refactor MUST NOT regress (both were fixed multiple times across the
 * P7.1 review history), split into:
 *
 *   1. BEHAVIOURAL — the `RequestGate` race-guard contract that
 *      `useProjectScopedAsync` is built on (acquire-before-await,
 *      isLatest-before-setState, reset-on-switch invalidation).
 *   2. STRUCTURAL — source-level guards asserting the extraction kept
 *      ONE mutate gate for all mutations, exactly four gates total, the
 *      render-phase reset-on-switch, and the reset-surface field set
 *      (including the fields that intentionally survive a switch).
 *
 * The structural guards read the extracted hook sources directly, so a
 * future edit that reintroduces a second mutation gate — or drops the
 * reset-on-switch — fails here instead of silently in production.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RequestGate } from '../lib/docs-client';

const FEATURES_DOCS = join(import.meta.dir, '..', 'features', 'docs');
function readHook(name: string): string {
  return readFileSync(join(FEATURES_DOCS, name), 'utf8');
}

describe('RequestGate — the useProjectScopedAsync race-guard contract', () => {
  it('acquire hands out monotonic tokens; only the latest isLatest', () => {
    const gate = new RequestGate();
    const a = gate.acquire();
    const b = gate.acquire();
    expect(b).not.toBe(a);
    // A fast A → B supersede: A's (slower) response must NOT be treated
    // as latest, so its isLatest-before-setState check bails.
    expect(gate.isLatest(a)).toBe(false);
    expect(gate.isLatest(b)).toBe(true);
  });

  it('reset invalidates every outstanding token (reset-on-switch)', () => {
    const gate = new RequestGate();
    const token = gate.acquire();
    expect(gate.isLatest(token)).toBe(true);
    // Project switch → reset. An in-flight op holding `token` now bails
    // before committing state under the new project.
    gate.reset();
    expect(gate.isLatest(token)).toBe(false);
  });

  it('a token acquired after reset is latest again', () => {
    const gate = new RequestGate();
    gate.acquire();
    gate.reset();
    const fresh = gate.acquire();
    expect(gate.isLatest(fresh)).toBe(true);
  });
});

describe('useProjectScopedAsync — committed reset-on-switch (never during render)', () => {
  const src = readHook('use-project-scoped-async.ts');

  it('memoises a single RequestGate for the component lifetime', () => {
    expect(src).toMatch(/useMemo\(\(\)\s*=>\s*new RequestGate\(\),\s*\[\]\)/);
  });

  it('resets the gate inside a useEffect (committed transition), not during render', () => {
    // Codex D7-r2: the reset MUST live in an effect so an abandoned /
    // suspended B render can never invalidate A's in-flight request.
    const resetIdx = src.indexOf('gate.reset()');
    const effectIdx = src.indexOf('useEffect(');
    expect(effectIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(effectIdx);
    // No bare render-phase mutation of the gate.
    const beforeEffect = src.slice(0, effectIdx);
    expect(beforeEffect).not.toContain('gate.reset()');
  });

  it('scopes the reset to the project AND the client/session (Codex D7-r4)', () => {
    // The pre-D7 effect reset every gate on `client` OR `project_id`
    // change (its dep was `fetchTree = f(client, project_id)`). A gate
    // keyed on `projectId` alone would let a request from a stale
    // session commit under a refreshed one.
    expect(src).toMatch(/useProjectScopedAsync\(\s*projectId: string,\s*client: unknown,?\s*\)/);
    expect(src).toMatch(/seenScope\.current\.projectId\s*!==\s*projectId/);
    expect(src).toMatch(/seenScope\.current\.client\s*!==\s*client/);
    // The reset effect depends on both scope inputs.
    expect(src).toMatch(/\},\s*\[projectId, client, gate\]\);/);
  });
});

describe('useDocMutations — ONE gate for ALL mutations (fixed 4× in review)', () => {
  const src = readHook('use-doc-mutations.ts');

  it('acquires exactly one project-scoped gate', () => {
    const gateAcquisitions = src.match(/useProjectScopedAsync\(/g) ?? [];
    expect(gateAcquisitions.length).toBe(1);
  });

  it('routes every write path through that single mutateGate — no stray second gate', () => {
    // The behavioural bail-on-switch coverage lives in
    // docs-mutations-race.test.ts (all seven mutations). Here we only
    // pin the STRUCTURAL single-gate guarantee.
    expect(src).toContain('const mutateGate = useProjectScopedAsync(project_id, client);');
    expect(src).not.toMatch(/new RequestGate\(/);
  });

  it('project-switch reset clears ALL confirm modals but PRESERVES non-destructive transient flags', () => {
    // Isolate JUST the bounded project-change effect body (start → its
    // own `}, [project_id, client]);`) so moving a setter OUT of the
    // effect can't satisfy these assertions (Codex D7-r2).
    const start = src.indexOf('useEffect(() => {\n    setExistingFileConflict(null);');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('}, [project_id, client]);', start);
    expect(end).toBeGreaterThan(start);
    const effect = src.slice(start, end);
    expect(effect).toContain('setExistingFileConflict(null)');
    expect(effect).toContain('setActionSheet(null)');
    expect(effect).toContain('setRenameTarget(null)');
    expect(effect).toContain('setNewFileOpen(false)');
    // Every DESTRUCTIVE confirm-modal target must clear on switch so it
    // can't be confirmed against the wrong project (Codex D7-r1 BLOCKER
    // — the pre-D7 effect missed binaryDeleteTarget). Behaviourally
    // re-verified in docs-mutations-race.test.ts.
    expect(effect).toContain('setBinaryDeleteTarget(null)');
    // Non-destructive transient flags intentionally persist (matching
    // the pre-D7 effect) — resetting them would be a behaviour change
    // with no safety benefit.
    expect(effect).not.toContain('setUploadingBinary(');
    expect(effect).not.toContain('setEditorSelection(');
    expect(effect).not.toContain('setDragOver(');
  });
});

describe('docs tab keeps exactly four project-scoped gates (pre-D7: 4 RequestGates)', () => {
  it('tree + file + history + mutations each own one gate, and no more', () => {
    const hooks = ['use-doc-tree.ts', 'use-doc-file.ts', 'use-doc-history.ts', 'use-doc-mutations.ts'];
    const total = hooks.reduce((sum, name) => {
      const matches = readHook(name).match(/useProjectScopedAsync\(/g) ?? [];
      return sum + matches.length;
    }, 0);
    expect(total).toBe(4);
  });
});

describe('useDocTree — tree cleared BEFORE refetch (round-7 BLOCKING #2 ordering)', () => {
  const src = readHook('use-doc-tree.ts');
  it('the project-change effect setTree([]) precedes fetchTree()', () => {
    const effectStart = src.indexOf('useEffect(() => {\n    setTree([]);');
    expect(effectStart).toBeGreaterThanOrEqual(0);
    const setTreeIdx = src.indexOf('setTree([])', effectStart);
    const fetchIdx = src.indexOf('void fetchTree()', effectStart);
    expect(setTreeIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThan(setTreeIdx);
  });
});

// ── Panes: SOURCE-TEXT wiring guards (fallback only) ──────────────────
// The presentational panes (DocViewerPane / DocHistoryPane) import
// react-native, which bun cannot parse (Flow) and cannot safely mock in
// the run-tests.sh partitioned runner without corrupting real-RN imports
// in chunk-mate suites. Their RENDER behaviour is therefore covered by
// the agent-browser smoke (the repo convention — see
// comments-side-pane.test.tsx). These source-text guards are a weak
// backstop that the extracted panes still READ the hook objects they're
// handed, so a future edit that decouples a pane from its hook at least
// trips here.
describe('docs-panes — hook wiring (source-text backstop)', () => {
  const src = readHook('docs-panes.tsx');

  it('DocViewerPane consumes docFile/docHistory/docMutations/anchor and renders the viewer', () => {
    const pane = src.slice(src.indexOf('export function DocViewerPane'), src.indexOf('export function DocHistoryPane'));
    expect(pane).toContain('docFile');
    expect(pane).toContain('docHistory');
    expect(pane).toContain('docMutations');
    expect(pane).toContain('anchor');
    expect(pane).toContain('file === null');
    expect(pane).toContain('testID="docs-viewer"');
  });

  it('DocHistoryPane maps docHistory.historyEntries into rows', () => {
    const pane = src.slice(src.indexOf('export function DocHistoryPane'));
    expect(pane).toContain('docHistory');
    expect(pane).toMatch(/historyEntries\.map\(/);
    expect(pane).toContain('docs-history-row-');
  });
});
