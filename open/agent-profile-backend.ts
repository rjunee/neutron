/**
 * @neutronai/open — single-owner AgentProfileBackend (M1 Settings wiring).
 *
 * The agent-settings Core exposes `update_agent_name` / `update_personality`,
 * which the onboarding final-handoff promises the user can call later ("switch
 * personality / update my name later — just ask"). Both route through an
 * injected `AgentProfileBackend`; in a hosted deployment that backend
 * opens the RW registry row (`NEUTRON_REGISTRY_DB_PATH`). Open has NO registry,
 * so historically `mount-open-cores.ts` threaded nothing and the Core fell back
 * to the `available:false` no-op — both tools returned
 * `SETTINGS_BACKEND_UNAVAILABLE_ERROR` ("Settings backend unavailable — please
 * report this"). A broken promise on every Open box (m1-e2e-round4 § Settings).
 *
 * This module is the Open-appropriate writer. There is exactly one durable
 * surface that actually feeds the LIVE agent's identity in Open: the persona
 * files under `<owner_home>/persona/`, read every agent turn by
 * `PersonaPromptLoader` (`gateway/realmode-composer/persona-loader.ts`) and
 * spliced into the system prompt. `NEUTRON_AGENT_NAME` is read once at boot
 * (`owner-identity.ts:resolveOpenInstanceInfo`) but is NOT used to compose the
 * prompt, so persisting a name there would not change what the agent calls
 * itself. Therefore name + personality are persisted to:
 *
 *   1. `<owner_home>/persona/agent-profile.json` — the canonical scalar store
 *      (`{ agent_name, agent_personality }`), mirroring the registry row's two
 *      columns. This is the `get()` source so a partial `update_personality`
 *      can recover the untouched side (see `parsePersonality` in the Core).
 *
 *   2. `<owner_home>/persona/SOUL.md` — a clearly-delimited managed block at the
 *      TOP of the file (before any onboarding-authored body). The block states
 *      the authoritative name + personality and instructs the model that they
 *      override anything below, so a later turn reflects the change even though
 *      the onboarding opener ("You are <old name>.") remains further down.
 *
 * Hot-reload: SOUL.md is written via atomic `writeFile(tmp); rename(tmp,target)`,
 * which bumps its mtime — `PersonaPromptLoader`'s mtime-keyed cache re-reads it
 * on the very next agent turn (see persona-loader.ts § Caching). For immediacy
 * the composer also wires `onProfileChange` to `personaLoader.invalidate('SOUL.md')`
 * so the cache entry is dropped the instant the write commits.
 *
 * Writes mirror `admin-personality-surface.ts`'s atomic-rename + `O_NOFOLLOW`
 * discipline so a hostile `persona/SOUL.md -> /etc/...` symlink can never be
 * followed by a profile write.
 */

import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentProfileBackend } from '../cores/free/agent-settings/index.ts'

/** The SOUL.md filename the PersonaPromptLoader reads first (identity file). */
const SOUL_FILENAME = 'SOUL.md'

/** Canonical scalar profile store — mirrors the registry row's two columns. */
const PROFILE_STORE_FILENAME = 'agent-profile.json'

/**
 * Delimiters for the managed block this backend owns inside SOUL.md. Everything
 * between them is regenerated on each write; everything outside is preserved
 * byte-for-byte. Stable strings so a hand-edited or onboarding-authored SOUL.md
 * is never clobbered and the block is idempotently replaceable.
 */
export const PROFILE_BLOCK_START =
  '<!-- BEGIN neutron-agent-profile (managed by update_agent_name / update_personality — do not edit by hand) -->'
export const PROFILE_BLOCK_END = '<!-- END neutron-agent-profile -->'

export interface OpenAgentProfile {
  agent_name: string | null
  agent_personality: string | null
}

export interface OpenAgentProfileBackendOptions {
  /** Absolute path to `<owner_home>` — persona files live at `<owner_home>/persona/<name>`. */
  owner_home: string
  /** Process env (read for the `NEUTRON_AGENT_NAME` boot default). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Fired after every committed name/personality write so the composer can
   * invalidate the `PersonaPromptLoader` SOUL.md cache entry and reflect the
   * change on the next turn without waiting for the mtime path. Best-effort —
   * a throw here is logged and swallowed (the persist already committed).
   */
  onProfileChange?: () => void
  /** Optional structured logger; defaults to `console.warn`. */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

/**
 * Render the managed SOUL.md block from the current profile. Returns an empty
 * string when neither field is set (the block is then removed entirely).
 */
export function renderProfileBlock(profile: OpenAgentProfile): string {
  const name = profile.agent_name?.trim()
  const personality = profile.agent_personality?.trim()
  if ((name === undefined || name.length === 0) && (personality === undefined || personality.length === 0)) {
    return ''
  }
  const lines: string[] = [PROFILE_BLOCK_START]
  if (name !== undefined && name.length > 0) {
    lines.push(`You are ${name}.`)
  }
  if (personality !== undefined && personality.length > 0) {
    if (name !== undefined && name.length > 0) lines.push('')
    lines.push(`Your personality: ${personality}`)
  }
  lines.push('')
  lines.push(
    'This name and personality are authoritative and override any other name or disposition described below.',
  )
  lines.push(PROFILE_BLOCK_END)
  return lines.join('\n')
}

/**
 * Splice the managed block into `existing` SOUL.md content. Replaces a prior
 * managed block in place (idempotent), or prepends a fresh one above the
 * existing body. When `block` is empty, strips any prior managed block. The
 * onboarding-authored / hand-edited body is preserved verbatim either way.
 */
export function spliceProfileBlock(existing: string, block: string): string {
  const startIdx = existing.indexOf(PROFILE_BLOCK_START)
  const endIdx = existing.indexOf(PROFILE_BLOCK_END)
  let body = existing
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Remove the prior managed block (plus a trailing blank line it owned).
    const after = existing.slice(endIdx + PROFILE_BLOCK_END.length).replace(/^\n+/, '')
    body = existing.slice(0, startIdx).replace(/\n+$/, '')
    body = body.length > 0 ? `${body}\n${after}` : after
  }
  body = body.replace(/^\n+/, '')
  if (block.length === 0) return body
  return body.length > 0 ? `${block}\n\n${body}` : `${block}\n`
}

/**
 * Build the single-owner Open `AgentProfileBackend`. Persists agent name +
 * personality to `<owner_home>/persona/agent-profile.json` and re-renders the
 * managed block in `<owner_home>/persona/SOUL.md` so the live agent reflects the
 * change on its next turn. `available` is always true — an Open box can always
 * write its own persona files.
 */
export function buildOpenAgentProfileBackend(
  opts: OpenAgentProfileBackendOptions,
): AgentProfileBackend {
  const env = opts.env ?? process.env
  const personaDir = join(opts.owner_home, 'persona')
  const storePath = join(personaDir, PROFILE_STORE_FILENAME)
  const soulPath = join(personaDir, SOUL_FILENAME)
  const log =
    opts.log ?? ((msg, meta): void => console.warn(`[open-agent-profile] ${msg}`, meta ?? {}))

  const readStore = async (): Promise<OpenAgentProfile> => {
    let raw: string
    try {
      raw = await readFile(storePath, 'utf8')
    } catch {
      // No store yet — fall back to the boot env name (the only pre-existing
      // signal), no personality.
      const envName = env['NEUTRON_AGENT_NAME']
      return {
        agent_name: typeof envName === 'string' && envName.trim().length > 0 ? envName.trim() : null,
        agent_personality: null,
      }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OpenAgentProfile>
      return {
        agent_name: typeof parsed.agent_name === 'string' ? parsed.agent_name : null,
        agent_personality:
          typeof parsed.agent_personality === 'string' ? parsed.agent_personality : null,
      }
    } catch {
      log('agent-profile.json is corrupt; treating as empty', { storePath })
      return { agent_name: null, agent_personality: null }
    }
  }

  /**
   * Refuse to write through a symlinked `persona/` directory. `mkdir(...,
   * { recursive: true })` accepts an existing symlink and would let a hostile
   * `persona -> /elsewhere` redirect the profile writes outside `owner_home`.
   * The PersonaPromptLoader + admin-personality-surface reject a symlinked
   * `persona/` dir for reads (ISSUE #37); the writer enforces the same.
   */
  const assertPersonaDirSafe = async (): Promise<void> => {
    try {
      const st = await lstat(personaDir)
      if (st.isSymbolicLink()) {
        throw new Error(
          `persona directory rejected: symlink (refusing to write agent profile through ${personaDir})`,
        )
      }
    } catch (err) {
      // Re-throw our own rejection; a missing dir (ENOENT) is fine — mkdir
      // below creates a real one.
      if (err instanceof Error && err.message.startsWith('persona directory rejected')) throw err
    }
  }

  /** Atomic write via tmp + rename, with the persona dir created on demand. */
  const atomicWrite = async (target: string, content: string): Promise<void> => {
    await assertPersonaDirSafe()
    await mkdir(personaDir, { recursive: true })
    const tmp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFileNoFollow(tmp, content)
      await rename(tmp, target)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // best-effort cleanup
      }
      throw err
    }
  }

  /** Read SOUL.md, refusing to follow a symlink at that path (defense-in-depth). */
  const readSoul = async (): Promise<string> => {
    let fh: Awaited<ReturnType<typeof open>>
    try {
      fh = await open(soulPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch {
      // Missing (ENOENT) or symlink-rejected (ELOOP) → treat as empty body so
      // a fresh managed block is created.
      return ''
    }
    try {
      return await fh.readFile('utf8')
    } catch {
      return ''
    } finally {
      await fh.close()
    }
  }

  const persist = async (next: OpenAgentProfile): Promise<void> => {
    // 1. Canonical scalar store (the `get()` source).
    await atomicWrite(storePath, `${JSON.stringify(next, null, 2)}\n`)
    // 2. Re-render the managed block in SOUL.md so the live agent reflects it.
    const existing = await readSoul()
    const block = renderProfileBlock(next)
    const updated = spliceProfileBlock(existing, block)
    await atomicWrite(soulPath, updated.endsWith('\n') ? updated : `${updated}\n`)
    // 3. Drop the persona-loader cache so the next turn re-reads immediately.
    try {
      opts.onProfileChange?.()
    } catch (err) {
      log('onProfileChange hook threw (write already committed)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Serialize the read-modify-write of the two setters. An agent can issue
  // `update_agent_name` AND `update_personality` in the SAME turn; without a
  // lock both would read the same old store, then each persist a full snapshot
  // and the last writer would drop the other's field. The chain makes each
  // setter read the latest store after the prior write committed.
  let writeChain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn)
    // Keep the chain alive regardless of this op's outcome (don't let a reject
    // poison subsequent writes); swallow here, surface via the returned promise.
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    available: true,
    async get(): Promise<{ agent_name: string | null; agent_personality: string | null }> {
      return await readStore()
    },
    async setAgentName(agent_name: string | null): Promise<void> {
      await serialize(async () => {
        const current = await readStore()
        await persist({ ...current, agent_name })
      })
    },
    async setAgentPersonality(agent_personality: string | null): Promise<void> {
      await serialize(async () => {
        const current = await readStore()
        await persist({ ...current, agent_personality })
      })
    },
  }
}

/**
 * `writeFile` that refuses to follow a symlink at the final path component.
 * Uses `O_CREAT | O_WRONLY | O_TRUNC | O_NOFOLLOW`. The target is always a
 * fresh randomly-named tmp file (atomicWrite), so `O_NOFOLLOW` here is purely
 * defense-in-depth against a pre-planted symlink at the tmp path.
 */
async function writeFileNoFollow(target: string, content: string): Promise<void> {
  const fh = await open(
    target,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}
