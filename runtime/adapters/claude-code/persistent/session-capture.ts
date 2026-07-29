/**
 * session-capture.ts — confirm a spawned REPL's session is durably resumable.
 *
 * LIFTED from Nova `gateway/index.ts` `captureSessionId` (§ 1 #7,
 * ◆ ADAPTED-AT-BOUNDARY). Nova had to POLL `~/.claude/sessions/<pid>.json`
 * for a stable UUID that CC picked on its own. Neutron PINS the session UUID
 * up-front via `--session-id` (see `build-repl-argv.ts`), so the capture step
 * degenerates to the part that actually matters: the JSONL-existence gate —
 * poll until `<projectsDir>/<cwd-dashed>/<sessionId>.jsonl` exists with ≥1
 * line, bounded by a cap, before treating the session as resumable.
 *
 * This preserves Nova's ghost-session guard discipline (2026-04-13 incident):
 * never treat a session as resumable until it has a real transcript on disk.
 */

import { validateAndPersistSessionId } from './session-validation.ts'

export interface CaptureSessionDeps {
  /** Returns true once the JSONL for `sessionId` under `cwd` exists with ≥1
   *  line. Production wraps `validateAndPersistSessionId`. */
  jsonlExists: (sessionId: string, cwd: string) => boolean
  /** Sleep `ms` between attempts. */
  sleep: (ms: number) => Promise<void>
}

export interface CaptureSessionConfig {
  /** Max poll attempts. Default 5. */
  maxAttempts?: number
  /** Delay between attempts (ms). Default 6000 (≈30s total at the default cap). */
  attemptDelayMs?: number
}

export interface CaptureSessionResult {
  /** True iff the JSONL gate passed within the cap. */
  captured: boolean
  /** Attempts consumed. */
  attempts: number
}

/**
 * Poll until the pre-assigned `sessionId`'s transcript JSONL exists on disk
 * (the ghost-session gate), bounded by the attempt cap. A miss after the cap
 * returns `captured: false` — the caller proceeds with the live REPL but must
 * NOT treat the session as resumable for a future respawn yet (Sprint 2).
 */
export async function captureSession(
  sessionId: string,
  cwd: string,
  deps: CaptureSessionDeps,
  config: CaptureSessionConfig = {},
): Promise<CaptureSessionResult> {
  const maxAttempts = config.maxAttempts ?? 5
  const attemptDelayMs = config.attemptDelayMs ?? 6000
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.jsonlExists(sessionId, cwd)) {
      return { captured: true, attempts: attempt }
    }
    if (attempt < maxAttempts) await deps.sleep(attemptDelayMs)
  }
  return { captured: false, attempts: maxAttempts }
}

/** Production helper: wraps `validateAndPersistSessionId` as the `jsonlExists`
 *  dep, threading the per-instance projects dir. */
export function makeJsonlExistsProbe(
  projectsDir?: string,
): (sessionId: string, cwd: string) => boolean {
  return (sessionId, cwd) => validateAndPersistSessionId(sessionId, cwd, projectsDir)
}
