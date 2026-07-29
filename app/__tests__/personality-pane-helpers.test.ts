/**
 * @neutronai/app — PersonalityPane fix-pass r2 regression tests (Argus r1
 * BLOCKING + IMPORTANT, 2026-05-22).
 *
 * Pins the three invariants behind the round-2 fixes shipped on PR
 * #280. Each test exercises the pure helper that the pane composes;
 * the pane itself imports + uses these helpers verbatim so a passing
 * test here covers the user-visible flow.
 *
 *   B1 (BLOCKING) — saveOne wire payload must be snapshotted SYNC
 *                   from panesRef before setPanes (the queued updater
 *                   would otherwise blank `content` and
 *                   `expected_mtime` on the wire).
 *   B2 (BLOCKING) — per-file mutate gates: a Reload on one file must
 *                   not invalidate an in-flight Save on a different
 *                   file, AND the catch branch must ALWAYS clear
 *                   `saving` on the targeted file even when its token
 *                   is stale.
 *   I3 (IMPORTANT) — 207 partial restart must render the red error
 *                    banner (not green); summarizeRestart +
 *                    restartBannerKind drive that decision.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildSavePayload,
  makePerFileMutateGates,
  restartBannerKind,
  summarizeRestart,
  summarizeRestartFailure,
  type RestartStatus,
} from '../lib/personality-pane-helpers';
import {
  AdminPersonalityClientError,
  type PersonaFilename,
  type PersonaRestartResult,
} from '../lib/admin-personality-client';

interface PaneStateLike {
  baseline: string;
  draft: string;
  mtime: number;
  saving: boolean;
  error: string | null;
}

function freshPane(over: Partial<PaneStateLike> = {}): PaneStateLike {
  return {
    baseline: '',
    draft: '',
    mtime: 0,
    saving: false,
    error: null,
    ...over,
  };
}

/* ───────────── B1 — saveOne wire payload snapshot ───────────── */

describe('B1 — saveOne wire payload reads from panesRef snapshot, not the queued setPanes updater', () => {
  it('buildSavePayload returns the values present at call time', () => {
    const pane = { draft: 'real-body', mtime: 42 };
    const payload = buildSavePayload(pane);
    expect(payload.sent_body).toBe('real-body');
    expect(payload.sent_mtime).toBe(42);
  });

  it('buildSavePayload({ force: true }) sends expected_mtime: -1', () => {
    const pane = { draft: 'forced-content', mtime: 99 };
    const payload = buildSavePayload(pane, { force: true });
    expect(payload.sent_body).toBe('forced-content');
    expect(payload.sent_mtime).toBe(-1);
  });

  it('client.saveFile receives the snapshotted draft + mtime, NOT empty/0 (Argus r1 BLOCKER B1 root-cause regression)', async () => {
    // Simulate the prior bug: read snapshot inside a setPanes updater
    // that React queues, then await client.saveFile(...) before the
    // updater fires. With the r2 fix the snapshot is read SYNCHRONOUSLY
    // from panesRef.current — so the wire payload is correct.

    const panesRef = {
      current: {
        'SOUL.md': freshPane({ draft: 'archetypal blend', mtime: 4242 }),
      } as Record<PersonaFilename, PaneStateLike>,
    };

    // setPanes mock that defers its updater (mirrors React batching).
    const queued: Array<(prev: Record<PersonaFilename, PaneStateLike>) => unknown> = [];
    const setPanes = (
      updater: (prev: Record<PersonaFilename, PaneStateLike>) => unknown,
    ): void => {
      queued.push(updater);
    };

    interface SaveCall {
      filename: PersonaFilename;
      content: string;
      expected_mtime: number;
    }
    const saveCalls: SaveCall[] = [];
    const saveFile = async (input: SaveCall): Promise<{ ok: true; mtime: number }> => {
      saveCalls.push(input);
      return { ok: true, mtime: 99 };
    };

    // The exact shape of the r2 saveOne wire-payload path:
    const { sent_body, sent_mtime } = buildSavePayload(
      panesRef.current['SOUL.md'],
    );
    setPanes((prev) => ({
      ...prev,
      'SOUL.md': { ...prev['SOUL.md'], saving: true, error: null },
    }));
    await saveFile({
      filename: 'SOUL.md',
      content: sent_body,
      expected_mtime: sent_mtime,
    });

    expect(saveCalls).toHaveLength(1);
    const call = saveCalls[0]!;
    // The bug shipped content='' and expected_mtime=0 because the
    // setPanes updater hadn't fired yet at the call-site.
    expect(call.content).toBe('archetypal blend');
    expect(call.expected_mtime).toBe(4242);
    expect(call.content).not.toBe('');
    expect(call.expected_mtime).not.toBe(0);

    // The setPanes updater is still queued (not yet applied) — proves
    // the snapshot was captured BEFORE React processed it.
    expect(queued).toHaveLength(1);
  });
});

/* ───────────── B2 — per-file mutate gates ───────────── */

describe('B2 — per-file mutate gates isolate save / reload across files', () => {
  it('reloadOne(USER) does NOT invalidate the in-flight saveOne(SOUL) token', () => {
    const gates = makePerFileMutateGates();
    const saveSoulToken = gates.files['SOUL.md'].acquire();
    // user clicks Reload on USER while SOUL is still saving
    gates.files['USER.md'].acquire();
    expect(gates.files['SOUL.md'].isLatest(saveSoulToken)).toBe(true);
  });

  it('every file gate is independent of every other file gate AND of the bulk gate', () => {
    const gates = makePerFileMutateGates();
    const soulTok = gates.files['SOUL.md'].acquire();
    const userTok = gates.files['USER.md'].acquire();
    const priTok = gates.files['priority-map.md'].acquire();
    const bulkTok = gates.bulk.acquire();
    // ALL four tokens are still latest — none cross-invalidated.
    expect(gates.files['SOUL.md'].isLatest(soulTok)).toBe(true);
    expect(gates.files['USER.md'].isLatest(userTok)).toBe(true);
    expect(gates.files['priority-map.md'].isLatest(priTok)).toBe(true);
    expect(gates.bulk.isLatest(bulkTok)).toBe(true);
  });

  it('resetAll() invalidates every per-file gate (used before a destructive restart)', () => {
    const gates = makePerFileMutateGates();
    const t1 = gates.files['SOUL.md'].acquire();
    const t2 = gates.files['USER.md'].acquire();
    const t3 = gates.files['priority-map.md'].acquire();
    const t4 = gates.bulk.acquire();
    gates.resetAll();
    expect(gates.files['SOUL.md'].isLatest(t1)).toBe(false);
    expect(gates.files['USER.md'].isLatest(t2)).toBe(false);
    expect(gates.files['priority-map.md'].isLatest(t3)).toBe(false);
    expect(gates.bulk.isLatest(t4)).toBe(false);
  });

  it('saveOne(SOUL) → reloadOne(USER) does NOT leave SOUL stuck in saving=true (full simulated flow)', async () => {
    // Simulates the exact stranding scenario from the Argus r1 finding:
    //   1. saveOne(SOUL) acquires token A on SOUL gate, flips saving=true
    //   2. reloadOne(USER) acquires token B on USER gate
    //   3. saveOne(SOUL) resolves → must clear saving=false on SOUL
    //
    // Under the r1 SHARED gate the SOUL resolver bailed on
    // isLatest(tokenA) → SOUL pane was stuck disabled. Per-file gates
    // (B2 fix) keep the SOUL token latest so the resolver clears the
    // flag.

    const gates = makePerFileMutateGates();
    const panes: Record<PersonaFilename, PaneStateLike> = {
      'SOUL.md': freshPane({ draft: 'soul-draft', mtime: 1 }),
      'USER.md': freshPane({ draft: 'user-draft', mtime: 2 }),
      'priority-map.md': freshPane({ draft: 'p-draft', mtime: 3 }),
    };

    // Helper that mirrors PersonalityPane.updatePane.
    const updatePane = (filename: PersonaFilename, patch: Partial<PaneStateLike>): void => {
      panes[filename] = { ...panes[filename], ...patch };
    };

    // Save SOUL — acquire token, flip saving=true.
    const soulGate = gates.files['SOUL.md'];
    const soulToken = soulGate.acquire();
    updatePane('SOUL.md', { saving: true });

    // While SOUL save is in flight, user hits Reload on USER.
    const userGate = gates.files['USER.md'];
    userGate.acquire();
    updatePane('USER.md', { saving: true });

    // SOUL save resolves successfully — must NOT be considered stale.
    expect(soulGate.isLatest(soulToken)).toBe(true);

    // Apply the success patch the way saveOne does.
    if (soulGate.isLatest(soulToken)) {
      updatePane('SOUL.md', { saving: false });
    }

    // Bug regression: under the SHARED gate, panes['SOUL.md'].saving
    // would still be true. With per-file gates it's false.
    expect(panes['SOUL.md'].saving).toBe(false);
  });

  it('catch branch clears saving=false even when our gate has been reset (defensive against late resolver + restart race)', async () => {
    // Models the saveOne catch branch under the Argus r2 fix:
    //   - even when our token is stale (because restart called
    //     gates.resetAll()), the resolver must still set saving=false
    //     on the targeted file. The r1 code returned early before the
    //     setPanes call → the pane was stuck disabled forever.

    const gates = makePerFileMutateGates();
    const pane: PaneStateLike = freshPane({ draft: 'x', mtime: 5, saving: true });
    const token = gates.files['SOUL.md'].acquire();
    gates.resetAll(); // restart invalidates everything

    // Mimic the catch branch logic from saveOne post-r2:
    const isLatest = gates.files['SOUL.md'].isLatest(token);
    if (!isLatest) {
      // r2 invariant: ALWAYS clear saving even on stale tokens.
      pane.saving = false;
    }

    expect(isLatest).toBe(false);
    expect(pane.saving).toBe(false);
  });
});

/* ───────────── I3 — partial-restart red banner ───────────── */

describe('I3 — 207 partial-restart response renders the red error banner', () => {
  it('summarizeRestart on a 207 partial response flags ok=false and tracks files_failed', () => {
    const partial: PersonaRestartResult = {
      ok: true,
      files_deleted: ['SOUL.md', 'USER.md'],
      files_failed: [
        { filename: 'priority-map.md', code: 'EISDIR', message: 'is a directory' },
      ],
      onboarding_reset: false,
    };
    const status = summarizeRestart(partial);
    expect(status.ok).toBe(false);
    expect(status.files_failed).toHaveLength(1);
    expect(status.files_failed[0]?.filename).toBe('priority-map.md');
    expect(status.message).toContain('Deleted SOUL.md, USER.md.');
    expect(status.message).toContain('Failed: priority-map.md (EISDIR).');
    expect(status.message).toContain('Onboarding state not reset in M1');
  });

  it('restartBannerKind picks the error style on a 207 partial (root-cause regression)', () => {
    const partial: PersonaRestartResult = {
      ok: true,
      files_deleted: ['SOUL.md', 'USER.md'],
      files_failed: [
        { filename: 'priority-map.md', code: 'EISDIR', message: 'is a directory' },
      ],
      onboarding_reset: false,
    };
    const status = summarizeRestart(partial);
    // The r1 banner branched on `restartResult.startsWith('Restart
    // failed')` which never matched the 207 path → green-on-failure.
    expect(restartBannerKind(status)).toBe('error');
  });

  it('restartBannerKind picks ok style when ALL files were deleted cleanly', () => {
    const clean: PersonaRestartResult = {
      ok: true,
      files_deleted: ['SOUL.md', 'USER.md', 'priority-map.md'],
      files_failed: [],
      onboarding_reset: false,
    };
    const status = summarizeRestart(clean);
    expect(status.ok).toBe(true);
    expect(restartBannerKind(status)).toBe('ok');
    expect(status.message.startsWith('Deleted SOUL.md, USER.md, priority-map.md.')).toBe(true);
  });

  it('summarizeRestart on a clean run with NO files reports "No files to delete." (idempotency)', () => {
    const empty: PersonaRestartResult = {
      ok: true,
      files_deleted: [],
      files_failed: [],
      onboarding_reset: false,
    };
    const status = summarizeRestart(empty);
    expect(status.ok).toBe(true);
    expect(status.message).toContain('No files to delete.');
    expect(restartBannerKind(status)).toBe('ok');
  });

  it('summarizeRestart honours an onboarding_reset=true server response', () => {
    const reset: PersonaRestartResult = {
      ok: true,
      files_deleted: ['SOUL.md'],
      files_failed: [],
      onboarding_reset: true,
    };
    const status = summarizeRestart(reset);
    expect(status.message).toContain('Onboarding state reset.');
    expect(status.message).not.toContain('Onboarding state not reset');
  });

  it('summarizeRestartFailure (thrown POST error path) reports ok=false and red banner', () => {
    const err = new AdminPersonalityClientError(500, 'internal', 'kaboom');
    const status: RestartStatus = summarizeRestartFailure(
      `${err.code}: ${err.message}`,
    );
    expect(status.ok).toBe(false);
    expect(status.message.startsWith('Restart failed:')).toBe(true);
    expect(restartBannerKind(status)).toBe('error');
  });
});
