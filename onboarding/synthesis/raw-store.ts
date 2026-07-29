/**
 * @neutronai/onboarding/synthesis — raw-transcript store (Step 2).
 *
 * Per the design (`onboarding-single-session-architecture-2026-06-17.md`):
 * "KEEP the raw transcripts — they are the project's source corpus + the
 * gbrain feed." The deterministic pre-pass streams the whole export and
 * writes every conversation's rendered transcript here keyed by
 * `conversation_id`; the synthesis session reads only the cheap signals and
 * NEVER pulls the raw text into the LLM context; the seed-writer pulls the
 * raw text back out for the conversations a project's bucket routed.
 *
 * Two implementations:
 *   - `DiskRawTranscriptStore` — production. Writes `<dir>/<id>.md`. A 3.6M-
 *     token export cannot sit in one process's memory, so disk is the
 *     canonical store. `conversation_id`s are sanitized to safe filenames.
 *   - `MemoryRawTranscriptStore` — tests + the no-import path (no transcripts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RawTranscriptStore {
  /** Persist one conversation's rendered transcript text. */
  put(conversation_id: string, text: string): void
  /** Retrieve a conversation's transcript, or null when absent. */
  get(conversation_id: string): string | null
  /** True iff a transcript was stored for this id. */
  has(conversation_id: string): boolean
}

/**
 * Map an arbitrary `conversation_id` to a safe, collision-resistant
 * filename. Source ids are UUIDs/slugs in practice but we never trust the
 * shape — a `/` or `..` in an id must not escape the store dir.
 */
export function rawFilenameFor(conversation_id: string): string {
  const safe = conversation_id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  // Guard against an id that sanitizes to empty / all-dots.
  const base = safe.replace(/^\.+/, '').length > 0 ? safe : `conv_${hashId(conversation_id)}`
  return `${base}.md`
}

function hashId(s: string): string {
  // Tiny non-crypto hash — only needs to disambiguate pathological ids.
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Disk-backed store. Files land flat under `dir` as `<sanitized-id>.md`. */
export class DiskRawTranscriptStore implements RawTranscriptStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /**
   * Persist one conversation's transcript, MATERIALIZING the corpus dir at
   * WRITE time, not just at construction.
   *
   * 2026-06-18 (import-transcript ENOENT root-cause fix): the store is
   * composed at landing-stack BOOT — long before any import — so the
   * constructor's one-shot `mkdirSync` is stale by the time the deterministic
   * pre-pass streams an export and calls `put` per conversation. On a fresh /
   * throwaway instance the `<owner_home>/imports/` subtree does not yet exist
   * (or was recreated) at write time, so the first `writeFileSync` threw
   * `ENOENT: ... open '<dir>/<first-conversation-id>.md'` — zero transcripts
   * landed and the synthesis read passes (and any later seed read) had nothing
   * to open, failing the whole import with `substrate_error` before pass 1.
   * Re-ensuring the dir on the ENOENT slow-path is idempotent, self-healing,
   * and zero-overhead on the happy path; it covers BOTH `chatgpt-zip` and
   * `claude-zip` (both flow parse -> pre-pass -> `put`).
   */
  put(conversation_id: string, text: string): void {
    const path = join(this.dir, rawFilenameFor(conversation_id))
    try {
      writeFileSync(path, text, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(path, text, 'utf8')
    }
  }

  get(conversation_id: string): string | null {
    const path = join(this.dir, rawFilenameFor(conversation_id))
    if (!existsSync(path)) return null
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  has(conversation_id: string): boolean {
    return existsSync(join(this.dir, rawFilenameFor(conversation_id)))
  }
}

/** In-memory store for tests + the no-import path. */
export class MemoryRawTranscriptStore implements RawTranscriptStore {
  private readonly map = new Map<string, string>()

  put(conversation_id: string, text: string): void {
    this.map.set(conversation_id, text)
  }

  get(conversation_id: string): string | null {
    return this.map.get(conversation_id) ?? null
  }

  has(conversation_id: string): boolean {
    return this.map.has(conversation_id)
  }
}
