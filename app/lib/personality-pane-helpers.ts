/**
 * @neutronai/app — pure helpers for the admin Personality pane (Argus r2,
 * 2026-05-22).
 *
 * Extracted from `app/app/admin.tsx` PersonalityPane to make the three
 * fix points testable without a React-Native renderer harness:
 *   - B1 wire payload snapshot — `buildSavePayload`
 *   - B2 per-file mutate gates — `makePerFileMutateGates`
 *   - I3 partial-restart red banner — `summarizeRestart`,
 *     `restartBannerKind`
 *
 * Every helper is pure (or a thin factory over RequestGate). The pane
 * imports + composes them; the tests in
 * `__tests__/personality-pane-helpers.test.ts` pin the invariants.
 */

import { RequestGate } from './docs-client';
import type {
  PersonaFilename,
  PersonaRestartFailure,
  PersonaRestartResult,
} from './admin-personality-client';
import { PERSONA_FILENAMES } from './admin-personality-client';

/** Subset of PaneState the save-payload builder needs. */
export interface PaneDraftView {
  draft: string;
  mtime: number;
}

export interface SavePayload {
  /** Body the client should PATCH. Snapshotted BEFORE any setPanes
   *  call so an async setPanes updater can't blank it (B1 root cause). */
  sent_body: string;
  /** `expected_mtime` the client should send. `-1` when force-overwriting. */
  sent_mtime: number;
}

/**
 * B1 fix — synchronous snapshot of `{draft, mtime}` for the file we're
 * about to PATCH. The caller MUST read this BEFORE invoking setPanes;
 * the prior implementation read inside the setPanes updater (queued),
 * so `client.saveFile({...})` evaluated its args from a stale closure
 * and sent `content: ''` / `expected_mtime: 0` on the wire.
 */
export function buildSavePayload(
  pane: PaneDraftView,
  opts: { force?: boolean } = {},
): SavePayload {
  return {
    sent_body: pane.draft,
    sent_mtime: opts.force === true ? -1 : pane.mtime,
  };
}

/**
 * B2 fix — one RequestGate per persona file PLUS one for the destructive
 * instance-wide restart. The prior implementation shared a single gate
 * across all 3 files + restart, which meant a click on Reload(USER)
 * invalidated the in-flight Save(SOUL) — that pane was then stuck with
 * `saving: true` because the catch branch bailed before clearing the
 * flag.
 */
export interface PerFileGates {
  /** One gate per allow-listed persona filename. */
  files: Record<PersonaFilename, RequestGate>;
  /** Separate gate for `restartFromScratch` + `fetchAll`. */
  bulk: RequestGate;
  /** Invalidate every per-file gate (e.g. before a restart so a late
   *  save resolver can't write stale baseline/mtime onto a file the
   *  server is about to delete). */
  resetAll: () => void;
}

export function makePerFileMutateGates(): PerFileGates {
  const files: Record<PersonaFilename, RequestGate> = {
    'SOUL.md': new RequestGate(),
    'USER.md': new RequestGate(),
    'priority-map.md': new RequestGate(),
  };
  const bulk = new RequestGate();
  return {
    files,
    bulk,
    resetAll: (): void => {
      for (const f of PERSONA_FILENAMES) files[f].reset();
      bulk.reset();
    },
  };
}

/**
 * I3 fix — derive a structured restart status from the server result.
 * The prior banner branched on `restartResult.startsWith('Restart
 * failed')`, which never matched the 207 partial path (server already
 * returns `files_failed: [...]` in that response). The result was a
 * green "success" banner shown next to text like "Failed:
 * priority-map.md (EISDIR)."
 */
export interface RestartStatus {
  /** Human-readable summary (rendered as the banner body). */
  message: string;
  /** True when EVERY targeted file was deleted (or was missing
   *  already). False on a 207 partial OR on a thrown error. */
  ok: boolean;
  /** Per-file failures from the 207 envelope. Empty on success. */
  files_failed: PersonaRestartFailure[];
}

export function summarizeRestart(result: PersonaRestartResult): RestartStatus {
  const failed = result.files_failed ?? [];
  const parts: string[] = [];
  if (result.files_deleted.length > 0) {
    parts.push(`Deleted ${result.files_deleted.join(', ')}.`);
  } else if (failed.length === 0) {
    parts.push('No files to delete.');
  }
  if (failed.length > 0) {
    parts.push(
      `Failed: ${failed.map((f) => `${f.filename} (${f.code})`).join(', ')}.`,
    );
  }
  if (result.onboarding_reset) {
    parts.push('Onboarding state reset.');
  } else {
    parts.push(
      'Onboarding state not reset in M1 — files are gone but the next chat behaves the same until the runtime persona-reader lands.',
    );
  }
  return {
    message: parts.join(' '),
    ok: failed.length === 0,
    files_failed: failed,
  };
}

/** Failure path — the POST itself threw (network / 5xx). */
export function summarizeRestartFailure(message: string): RestartStatus {
  return {
    message: `Restart failed: ${message}`,
    ok: false,
    files_failed: [],
  };
}

/**
 * I3 fix — banner colour selector. Red when ANY file failed to delete
 * OR the whole POST errored; green otherwise.
 */
export function restartBannerKind(status: RestartStatus): 'error' | 'ok' {
  return status.ok && status.files_failed.length === 0 ? 'ok' : 'error';
}
