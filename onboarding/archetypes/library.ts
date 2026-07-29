/**
 * @neutronai/onboarding — archetype library (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.2 + § 4.6. Hybrid model:
 *
 *   - 24 hand-tuned curated archetype md files in `data/<slug>.md`. Each
 *     contributes voice / comm / decision text fragments to the persona-
 *     gen step. Picked by exact slug or fuzzy name match.
 *   - LLM-extension fallback for non-curated names (e.g. "Bilbo Baggins").
 *     Cached on disk so a second user picking the same name reuses the
 *     fragment instead of re-billing for it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type ArchetypeSource = 'mythological' | 'fictional' | 'historical'

export interface Archetype {
  slug: string
  display_name: string
  source: ArchetypeSource
  voice_md: string
  comm_md: string
  decision_md: string
}

export type ArchetypeErrorCode = 'not_found' | 'compose_failed' | 'extension_failed' | 'malformed_data'

export class ArchetypeError extends Error {
  override readonly name = 'ArchetypeError'
  constructor(
    readonly code: ArchetypeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ArchetypeLibraryDeps {
  /** Directory containing the curated `<slug>.md` files. */
  dataDir: string
  /** Directory the LLM-extension cache lives at. */
  cacheDir: string
  /** Default 0.85; lower = more aggressive matching. */
  fuzzyMatchThreshold?: number
  /** Substrate-shaped LLM call for extension generation. Tests inject. */
  generateExtension?: (name: string) => Promise<{ voice_md: string; comm_md: string; decision_md: string }>
}

export interface SubstrateArchetypeGenerator {
  (input: { prompt: string; name: string }): Promise<string>
}

/**
 * Loads + indexes the 24 curated archetypes. Production callers wire the
 * data dir to `onboarding/archetypes/data/`; tests can point to fixture dirs.
 *
 * Lookup precedence:
 *   1. `get(slug)` — direct slug match (returns null on miss).
 *   2. `matchByName(name)` — fuzzy match against `display_name` and slug.
 *      Threshold defaults to 0.85; below threshold returns null.
 *   3. `generateExtension(name)` — LLM-generated extension for non-curated
 *      names. Cached in `cacheDir/<sanitized>.json`.
 */
export class ArchetypeLibrary {
  private readonly registry: Map<string, Archetype> = new Map()
  private readonly threshold: number
  private readonly cacheDir: string
  private readonly extensionGen: ArchetypeLibraryDeps['generateExtension']

  constructor(deps: ArchetypeLibraryDeps) {
    this.threshold = deps.fuzzyMatchThreshold ?? 0.85
    this.cacheDir = deps.cacheDir
    if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true })
    if (deps.generateExtension !== undefined) {
      this.extensionGen = deps.generateExtension
    }
    this.loadCurated(deps.dataDir)
  }

  get(slug: string): Archetype | null {
    return this.registry.get(slug.toLowerCase()) ?? null
  }

  /**
   * Best-effort fuzzy match.
   *
   * Codex r9 P2 fix: a strict 0.85 Dice threshold misses common short
   * inputs for multi-word curated names (e.g. "Gandalf" vs the
   * "Gandalf the White" file = 0.55 Dice; "Picard" vs "Captain
   * Picard" = 0.40). Layered match order:
   *
   *   1. Direct slug lookup (lowercased).
   *   2. Exact display_name match (case-insensitive).
   *   3. Token-overlap match — the user-typed name is a prefix of any
   *      archetype's display_name OR every word in the input also
   *      appears in the display_name. Catches "Gandalf", "Picard",
   *      "Atticus", "Jane Eyre", etc.
   *   4. Dice coefficient at the configured threshold (default 0.85)
   *      as the typo-tolerance backstop.
   */
  matchByName(name: string): Archetype | null {
    const trimmed = name.trim().toLowerCase()
    if (trimmed.length === 0) return null
    const direct = this.registry.get(trimmed)
    if (direct !== undefined) return direct
    for (const arch of this.registry.values()) {
      if (arch.display_name.toLowerCase() === trimmed) return arch
    }
    // Codex r9 P2: token-overlap path. Pick the archetype whose
    // display_name shares the most tokens with the input; require at
    // least one shared token AND every input token to appear.
    const inputTokens = tokenize(trimmed)
    if (inputTokens.length > 0) {
      let token_best: { arch: Archetype; covered: number } | null = null
      for (const arch of this.registry.values()) {
        const nameTokens = new Set(tokenize(arch.display_name.toLowerCase()))
        const slugTokens = new Set(tokenize(arch.slug))
        let covered = 0
        let allMatched = true
        for (const t of inputTokens) {
          if (nameTokens.has(t) || slugTokens.has(t)) covered += 1
          else allMatched = false
        }
        if (allMatched && covered > 0) {
          if (token_best === null || covered > token_best.covered) {
            token_best = { arch, covered }
          }
        }
      }
      if (token_best !== null) return token_best.arch
    }
    let best: { arch: Archetype; score: number } | null = null
    for (const arch of this.registry.values()) {
      const score = Math.max(
        diceCoefficient(trimmed, arch.display_name.toLowerCase()),
        diceCoefficient(trimmed, arch.slug),
      )
      if (best === null || score > best.score) best = { arch, score }
    }
    if (best === null || best.score < this.threshold) return null
    return best.arch
  }

  list(): Archetype[] {
    return [...this.registry.values()]
  }

  /**
   * Generate a fragment for a non-curated name. Caches by sanitized slug
   * so the second invocation hits disk, not the LLM. The cache is opt-in
   * — clearing the file forces a regen.
   */
  async generateExtension(name: string): Promise<Archetype> {
    if (this.extensionGen === undefined) {
      throw new ArchetypeError(
        'extension_failed',
        `no generator wired; archetype "${name}" not curated and no LLM extension dep injected`,
      )
    }
    const slug = sanitizeSlug(name)
    const cachePath = join(this.cacheDir, `${slug}.json`)
    if (existsSync(cachePath)) {
      try {
        const raw = readFileSync(cachePath, 'utf8')
        const parsed = JSON.parse(raw) as Archetype
        return parsed
      } catch {
        // fall through and regenerate
      }
    }
    let parts: { voice_md: string; comm_md: string; decision_md: string }
    try {
      parts = await this.extensionGen(name)
    } catch (err) {
      throw new ArchetypeError('extension_failed', `LLM extension failed for ${name}`, err)
    }
    const arch: Archetype = {
      slug,
      display_name: name,
      source: 'fictional',
      voice_md: parts.voice_md,
      comm_md: parts.comm_md,
      decision_md: parts.decision_md,
    }
    writeFileSync(cachePath, JSON.stringify(arch, null, 2))
    return arch
  }

  private loadCurated(dataDir: string): void {
    if (!existsSync(dataDir)) {
      throw new ArchetypeError('malformed_data', `archetype data dir missing: ${dataDir}`)
    }
    const files = readdirSync(dataDir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      const path = join(dataDir, file)
      const raw = readFileSync(path, 'utf8')
      const arch = parseArchetypeMd(raw, file)
      this.registry.set(arch.slug.toLowerCase(), arch)
    }
  }
}

interface ParsedFrontmatter {
  slug?: string
  display_name?: string
  source?: ArchetypeSource
}

function parseArchetypeMd(raw: string, file: string): Archetype {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (fmMatch === null) {
    throw new ArchetypeError('malformed_data', `${file}: missing frontmatter`)
  }
  const fmBlock = fmMatch[1] ?? ''
  const body = fmMatch[2] ?? ''
  const fm: ParsedFrontmatter = {}
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (m === null) continue
    const key = m[1] ?? ''
    const value = (m[2] ?? '').trim()
    if (key === 'slug' || key === 'display_name') {
      fm[key] = value
    } else if (key === 'source') {
      if (value === 'mythological' || value === 'fictional' || value === 'historical') {
        fm.source = value
      }
    }
  }
  if (fm.slug === undefined || fm.display_name === undefined || fm.source === undefined) {
    throw new ArchetypeError('malformed_data', `${file}: frontmatter missing slug/display_name/source`)
  }
  const voice_md = extractSection(body, 'Voice')
  const comm_md = extractSection(body, 'Communication')
  const decision_md = extractSection(body, 'Decision')
  if (voice_md === null || comm_md === null || decision_md === null) {
    throw new ArchetypeError('malformed_data', `${file}: missing Voice / Communication / Decision section`)
  }
  return {
    slug: fm.slug,
    display_name: fm.display_name,
    source: fm.source,
    voice_md,
    comm_md,
    decision_md,
  }
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i')
  const m = body.match(re)
  if (m === null) return null
  return (m[1] ?? '').trim()
}

/**
 * T5 Codex r7 P2 — generate a stable per-name slug for the LLM-extension
 * cache. ASCII names keep their human-readable slug shape
 * ("Bilbo Baggins" → "bilbo-baggins"). Non-ASCII names (e.g. "孔子",
 * "Достоевский") would otherwise sanitize to the empty string and
 * collide on the cache key — a single `.json` cache entry would be
 * shared by every non-Latin name. Suffix a stable djb2 hex hash so
 * each typed name lands in a distinct cache key.
 */
function sanitizeSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii.length > 0) return ascii
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'custom'
  return `custom-${djb2Hex(trimmed)}`
}

function djb2Hex(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Split into lowercase word tokens, dropping common honorifics + filler
 * words that would otherwise force a "no overlap" verdict for inputs
 * like "Gandalf" against "Gandalf the White".
 */
const TOKEN_STOPWORDS: ReadonlySet<string> = new Set(['the', 'a', 'an', 'of', 'da'])

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !TOKEN_STOPWORDS.has(t))
}

/** Bigram Dice coefficient — robust fuzzy-match heuristic for short strings. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const aBigrams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2)
    aBigrams.set(bg, (aBigrams.get(bg) ?? 0) + 1)
  }
  let intersection = 0
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2)
    const count = aBigrams.get(bg) ?? 0
    if (count > 0) {
      intersection++
      aBigrams.set(bg, count - 1)
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1))
}
