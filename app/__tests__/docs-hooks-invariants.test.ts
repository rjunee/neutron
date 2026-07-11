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

describe('useProjectScopedAsync — render-phase reset-on-switch', () => {
  const src = readHook('use-project-scoped-async.ts');

  it('memoises a single RequestGate for the component lifetime', () => {
    expect(src).toMatch(/useMemo\(\(\)\s*=>\s*new RequestGate\(\),\s*\[\]\)/);
  });

  it('resets the gate when the projectId changes (ref compare, no effect lag)', () => {
    // The reset must be a render-phase compare so it precedes the
    // effect-phase refetch the switch triggers.
    expect(src).toMatch(/seenProject\.current\s*!==\s*projectId/);
    expect(src).toMatch(/gate\.reset\(\)/);
  });
});

describe('useDocMutations — ONE gate for ALL mutations (fixed 4× in review)', () => {
  const src = readHook('use-doc-mutations.ts');

  it('acquires exactly one project-scoped gate', () => {
    const gateAcquisitions = src.match(/useProjectScopedAsync\(/g) ?? [];
    expect(gateAcquisitions.length).toBe(1);
  });

  it('every write path checks isLatest on that single mutateGate', () => {
    // The token guard `mutateGate.isLatest(token)` appears once per
    // resolver arm across save / create / rename / delete / upload /
    // binary-delete / revert — never a second gate name.
    expect(src).toContain('const mutateGate = useProjectScopedAsync(project_id);');
    expect(src.match(/mutateGate\.acquire\(\)/g)?.length).toBeGreaterThanOrEqual(7);
    expect(src).toMatch(/mutateGate\.isLatest\(token\)/);
    // No stray second gate.
    expect(src).not.toMatch(/new RequestGate\(/);
  });

  it('project-switch reset clears ALL confirm modals but PRESERVES non-destructive transient flags', () => {
    // Isolate the project-change effect body.
    const effect = src.slice(src.indexOf('useEffect(() => {\n    setExistingFileConflict(null);'));
    expect(effect).toContain('setExistingFileConflict(null)');
    expect(effect).toContain('setActionSheet(null)');
    expect(effect).toContain('setRenameTarget(null)');
    expect(effect).toContain('setNewFileOpen(false)');
    // Every DESTRUCTIVE confirm-modal target must clear on switch so it
    // can't be confirmed against the wrong project (Codex D7-r1 BLOCKER
    // — the pre-D7 effect missed binaryDeleteTarget).
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
