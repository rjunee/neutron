/**
 * @neutronai/gateway/realmode-composer — persona-file loader (ISSUE #30).
 *
 * Reads `<owner_home>/persona/{SOUL,USER,priority-map}.md` at agent-turn
 * time and exposes the concatenated body for `composeSystemPrompt` to splice
 * above any per-phase system prompt. Backed by an mtime-keyed in-process
 * cache so steady-state agent turns hit one `stat` per file and zero
 * `readFile` calls — see § Caching below.
 *
 * Hot-reload contract:
 *   - `admin-personality-surface.ts` fires `onReload(filename)` after every
 *     successful PATCH / restart-from-scratch unlink. Production wires this
 *     to `loader.invalidate(filename)` so the very next agent turn re-reads
 *     the file. With cache-bust the next `load()` walks the mtime path,
 *     finds the new mtime, and updates the cache entry.
 *   - `invalidate()` with no argument clears all three entries — used by the
 *     restart-from-scratch path when every file gets unlinked at once.
 *
 * Missing / empty / symlinked file handling:
 *   - Files that don't exist (or fail `lstat` for any reason) are silently
 *     skipped and logged at `info` so onboarding-pre-persona-commit instances
 *     don't get a noisy warning every agent turn. Persona files committed
 *     post-onboarding will start appearing on the next turn after commit.
 *   - Files whose body trims to empty are also skipped + logged — keeps the
 *     spliced block from carrying a header for an empty section.
 *   - Files that are symlinks are rejected at `warn` level with the
 *     `rejected: symlink` substring (grep target). Mirrors `skills-loader.ts`
 *     symlink rejection but skips-and-logs instead of throwing so a hostile
 *     `persona/SOUL.md → /etc/passwd` doesn't break the other two files.
 *     ISSUE #37, Codex IMPORTANT on PR #283.
 *   - The `persona/` directory ITSELF is also lstat'd on every `load()`; if
 *     it resolves to a symlink the entire block is rejected (returns '')
 *     and a warn log fires. Closes the parent-dir escape that Codex P2
 *     flagged on the first-pass fix — a `persona -> /etc/` symlink would
 *     otherwise let regular files inside the symlink target slip past
 *     the per-file check.
 *   - The per-file read uses `open(O_NOFOLLOW)` rather than `readFile`, so
 *     a TOCTOU swap between the `lstat` symlink check and the read cannot
 *     splice an arbitrary file into the prompt. (Closes Codex P2 on PR #286;
 *     defense-in-depth — no concurrent swapper exists in production today.)
 *
 * Order:
 *   - SOUL.md  (voice / archetypal blend — sets the agent's identity FIRST)
 *   - USER.md  (facts about the user — what the agent should know)
 *   - priority-map.md  (program-priority routing — how decisions get made)
 *
 * Matches Nova's `CLAUDE.md` @-import order (SOUL → USER → TOOLS →
 * priority-map, minus TOOLS which Neutron instances don't ship yet).
 *
 * Caching (mtime-keyed):
 *   - First load: stat + readFile + cache `{ mtimeMs, content }`.
 *   - Second+ load (file unchanged): stat only, cache hit, no readFile.
 *   - Third load (file mutated externally without invalidate): stat returns
 *     a newer mtime, readFile fires, cache updates. Defends against the
 *     case where someone edits `<owner_home>/persona/SOUL.md` on disk via
 *     `ssh` instead of the admin surface.
 *   - File deleted: stat throws → entry evicted from cache so the next
 *     successful read after re-creation walks the cold path.
 */

import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The three persona files written by `onboarding/persona-gen/compose.ts:commit`
 * and editable via `gateway/http/admin-personality-surface.ts`. Locked to
 * this set so a future "add HEARTBEAT.md" requires a deliberate seam change.
 */
export const PERSONA_FILENAMES = ['SOUL.md', 'USER.md', 'priority-map.md'] as const
export type PersonaFilename = (typeof PERSONA_FILENAMES)[number]

export interface PersonaPromptLoaderOptions {
  /** Absolute path to `<owner_home>` — files live at `<owner_home>/persona/<name>`. */
  owner_home: string
  /**
   * Optional structured logger; defaults to `console.info` /
   * `console.warn`. Tests inject a recorder to assert log lines fire for
   * missing / empty files.
   */
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void
}

interface CacheEntry {
  mtimeMs: number
  content: string
}

/**
 * Loads + caches an instance's persona files for splicing into the system
 * prompt. ONE loader per instance per process — `invalidate(filename?)` is
 * the seam `admin-personality-surface.onReload` wires into.
 */
export class PersonaPromptLoader {
  private readonly opts: PersonaPromptLoaderOptions
  private readonly cache: Map<PersonaFilename, CacheEntry> = new Map()
  /**
   * Item 10 (2026-06-19, owner live-dogfood) — de-spam the missing-file
   * log. The owner's Open server log filled with
   *   [system-prompt] persona file 'SOUL.md' missing; skipping
   * THREE times per agent turn, because persona files only exist AFTER
   * onboarding's persona-gen commits them — pre-commit (the common Open
   * state) every turn re-logs all three. We log a given file's missing /
   * empty state at most ONCE per loader instance (until it appears, at
   * which point the latch clears so a later deletion re-logs once). The
   * one-shot line still satisfies the "logs at info" contract; the
   * per-turn spam is gone.
   */
  private readonly loggedAbsent: Set<PersonaFilename> = new Set()
  private readonly log: NonNullable<PersonaPromptLoaderOptions['log']>

  constructor(opts: PersonaPromptLoaderOptions) {
    this.opts = opts
    this.log =
      opts.log ??
      ((level, msg, meta): void => {
        if (level === 'info') console.info(`[system-prompt] ${msg}`, meta ?? {})
        else console.warn(`[system-prompt] ${msg}`, meta ?? {})
      })
  }

  /**
   * Read + concatenate the three persona files. Returns an empty string
   * when none of the files exists OR all are empty — `composeSystemPrompt`
   * then byte-identically returns the upstream `base` (the prompt-cache
   * anchor stays stable for pre-persona-commit instances).
   *
   * Each present, non-empty file is wrapped in
   * `<persona_file name="…">…</persona_file>` so the model can identify
   * the source of any particular instruction.
   */
  async load(): Promise<string> {
    // Security: reject the `persona/` directory itself if it's a symlink
    // (mirrors skills-loader.ts's root-dir lstat check). Otherwise a
    // instance-writable `persona -> /etc` would let regular files inside
    // the symlink target slip past the per-file `isSymbolicLink()` check
    // below — closing only the file-level door leaves the dir-level door
    // open. ISSUE #37 (Codex P2 follow-up on the initial fix).
    const personaDir = join(this.opts.owner_home, 'persona')
    try {
      const dirSt = await lstat(personaDir)
      if (dirSt.isSymbolicLink()) {
        this.cache.clear()
        this.log('warn', `persona directory rejected: symlink`, {
          owner_home: this.opts.owner_home,
          filename: 'persona',
        })
        return ''
      }
    } catch {
      // Missing persona/ directory — fall through; each file's `lstat`
      // below will trip the existing missing-file branch and the loader
      // returns ''. This is the legitimate pre-onboarding state.
    }
    const blocks: string[] = []
    for (const filename of PERSONA_FILENAMES) {
      const content = await this.readOne(filename)
      if (content === null) continue
      const trimmed = content.trim()
      if (trimmed.length === 0) {
        // De-spam: log the empty state once per file (same latch as the
        // missing path — an empty file is functionally absent here).
        if (!this.loggedAbsent.has(filename)) {
          this.loggedAbsent.add(filename)
          this.log('info', `persona file '${filename}' is empty; skipping`, {
            owner_home: this.opts.owner_home,
            filename,
          })
        }
        continue
      }
      // Present + non-empty — clear the absent-latch so a future
      // deletion / emptying re-logs exactly once.
      this.loggedAbsent.delete(filename)
      blocks.push(`<persona_file name="${filename}">\n${trimmed}\n</persona_file>`)
    }
    return blocks.join('\n\n')
  }

  /**
   * Clear one cache entry (or all, when called without args). The
   * production composer wires this to
   * `admin-personality-surface.onReload(filename)` so a PATCH / restart-
   * from-scratch unlink lands on the very next agent turn.
   */
  invalidate(filename?: PersonaFilename): void {
    if (filename === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(filename)
  }

  /**
   * Read a single file via the mtime-keyed cache. Returns null when the
   * file is missing (`lstat` throws) OR when the path is a symlink
   * (security — see ISSUE #37). Caller treats null and empty-string the
   * same way (`load()` skips both); the distinction matters only for the
   * log line shape.
   */
  private async readOne(filename: PersonaFilename): Promise<string | null> {
    const target = join(this.opts.owner_home, 'persona', filename)
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(target)
    } catch {
      // Missing file — evict any stale cache entry so a future re-create
      // walks the cold path with the fresh mtime.
      this.cache.delete(filename)
      // De-spam (Item 10): log the missing state at most once per file
      // per loader instance instead of every agent turn.
      if (!this.loggedAbsent.has(filename)) {
        this.loggedAbsent.add(filename)
        this.log('info', `persona file '${filename}' missing; skipping`, {
          owner_home: this.opts.owner_home,
          filename,
        })
      }
      return null
    }
    if (st.isSymbolicLink()) {
      // Security: an instance-writable symlink could splice an arbitrary
      // file (e.g. /etc/passwd) into the system prompt. Mirrors
      // skills-loader.ts symlink rejection but skips-and-logs instead of
      // throwing so the other persona files still load. ISSUE #37.
      this.cache.delete(filename)
      this.log('warn', `persona file '${filename}' rejected: symlink`, {
        owner_home: this.opts.owner_home,
        filename,
      })
      return null
    }
    const stMtimeMs = st.mtimeMs
    const cached = this.cache.get(filename)
    if (cached !== undefined && cached.mtimeMs === stMtimeMs) {
      return cached.content
    }
    // Open with `O_NOFOLLOW` so a TOCTOU swap between the `lstat()` above
    // and the read below (regular file at lstat time, symlink by the time
    // we read) cannot bypass the symlink rejection. POSIX `O_NOFOLLOW`
    // causes `open()` to fail with `ELOOP` when the final pathname
    // component resolves to a symlink — closes the race that Codex
    // flagged on PR #286 (defense-in-depth; Neutron's persona dir is
    // server-process-owned and admin writes go through `writeFile` to
    // literal paths, so no concurrent swapper exists today, but the
    // guarantee is now structural rather than circumstantial).
    let content: string
    let fh: Awaited<ReturnType<typeof open>>
    try {
      fh = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (err) {
      this.cache.delete(filename)
      if (isErrnoCode(err, 'ELOOP')) {
        this.log('warn', `persona file '${filename}' rejected: symlink`, {
          owner_home: this.opts.owner_home,
          filename,
        })
        return null
      }
      this.log('warn', `persona file '${filename}' read failed; skipping`, {
        owner_home: this.opts.owner_home,
        filename,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    try {
      content = await fh.readFile('utf8')
    } catch (err) {
      this.cache.delete(filename)
      this.log('warn', `persona file '${filename}' read failed; skipping`, {
        owner_home: this.opts.owner_home,
        filename,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    } finally {
      await fh.close()
    }
    this.cache.set(filename, { mtimeMs: stMtimeMs, content })
    return content
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === code
  )
}
