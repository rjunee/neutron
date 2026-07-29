/**
 * @neutronai/onboarding/profile-pic — 12-PNG archetype-keyed fallback gallery.
 *
 * Per docs/plans/P2-onboarding.md § 2.7 — when Gemini Imagen fails 3×
 * (or `runtime/credential-pool.ts` has no available credential),
 * onboarding falls back to this curated set of 12 archetype-keyed
 * portraits so the user never sees a stalled "generating…" prompt.
 *
 * The 12 PNGs land at `data/<slug>.png`. THE COMMITTED PNGs ARE
 * PLACEHOLDERS — solid 256×256 color blocks generated deterministically
 * for the test scaffold. The real artist-produced portraits drop in
 * pre-M2 by replacing each `data/<slug>.png` with the real asset; the
 * code does not change.
 *
 * Coverage matches the impeccable-skill-style seed: 5 mythological
 * (Odin, Thoth, Padmasambhava, Krishna, Athena), 1 fictional (Sherlock
 * Holmes), 5 historical (Musashi, Marcus Aurelius, Curie, Da Vinci,
 * Gandalf the White is fictional but slotted as "wisdom + protection"),
 * 1 mythological (Shiva) — explicitly NOT a 1:1 mirror of the 24-
 * archetype interview library: portraits cover the most-picked
 * archetypes, fallback `default` slug is used for any archetype not
 * directly represented.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The 12 archetype slugs in the bundled gallery. */
export const FALLBACK_ARCHETYPE_SLUGS = [
  'odin',
  'thoth',
  'padmasambhava',
  'musashi',
  'gandalf-the-white',
  'krishna',
  'athena',
  'shiva',
  'sherlock-holmes',
  'marcus-aurelius',
  'curie',
  'da-vinci',
] as const

export type FallbackArchetypeSlug = (typeof FALLBACK_ARCHETYPE_SLUGS)[number]

/** Default slug used when an archetype hint doesn't match any of the 12. */
export const FALLBACK_DEFAULT_SLUG: FallbackArchetypeSlug = 'gandalf-the-white'

export interface FallbackPortrait {
  slug: FallbackArchetypeSlug
  path: string
  bytes: Buffer
}

export type FallbackGalleryErrorCode = 'gallery_missing' | 'png_missing'

export class FallbackGalleryError extends Error {
  override readonly name = 'FallbackGalleryError'
  constructor(
    readonly code: FallbackGalleryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface FallbackGalleryDeps {
  /** Override the on-disk data dir. Defaults to `<this-file>/data`. */
  data_dir?: string
}

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

export class FallbackGallery {
  private readonly dataDir: string

  constructor(deps: FallbackGalleryDeps = {}) {
    this.dataDir = deps.data_dir ?? DEFAULT_DATA_DIR
  }

  /**
   * Return the on-disk path + bytes for the requested archetype slug.
   * Unknown slugs fall back to `FALLBACK_DEFAULT_SLUG`. Missing PNGs
   * throw `FallbackGalleryError{code:'png_missing'}`.
   */
  pick(slug: string | undefined): FallbackPortrait {
    const normalized = normalizeArchetype(slug)
    const path = join(this.dataDir, `${normalized}.png`)
    if (!existsSync(path)) {
      throw new FallbackGalleryError(
        'png_missing',
        `fallback PNG missing for slug=${normalized} at ${path}`,
      )
    }
    return { slug: normalized, path, bytes: readFileSync(path) }
  }

  /** Enumerate every PNG present in the data dir. Used for sanity checks. */
  list(): FallbackPortrait[] {
    if (!existsSync(this.dataDir)) {
      throw new FallbackGalleryError(
        'gallery_missing',
        `fallback gallery dir missing at ${this.dataDir}`,
      )
    }
    const entries = readdirSync(this.dataDir).filter((name) => name.endsWith('.png'))
    return entries.map((name) => {
      const slug = name.slice(0, -'.png'.length)
      const path = join(this.dataDir, name)
      const normalized = isFallbackSlug(slug) ? slug : FALLBACK_DEFAULT_SLUG
      return { slug: normalized, path, bytes: readFileSync(path) }
    })
  }

  /** Diagnostic — verify all 12 slugs resolve to an existing on-disk PNG. */
  verifyComplete(): { present: FallbackArchetypeSlug[]; missing: FallbackArchetypeSlug[] } {
    const present: FallbackArchetypeSlug[] = []
    const missing: FallbackArchetypeSlug[] = []
    for (const slug of FALLBACK_ARCHETYPE_SLUGS) {
      const path = join(this.dataDir, `${slug}.png`)
      if (existsSync(path)) present.push(slug)
      else missing.push(slug)
    }
    return { present, missing }
  }
}

function isFallbackSlug(value: string): value is FallbackArchetypeSlug {
  return (FALLBACK_ARCHETYPE_SLUGS as readonly string[]).includes(value)
}

/**
 * Map an arbitrary archetype hint (case-insensitive, dashes-or-spaces)
 * to one of the 12 fallback slugs. Unknown hints become
 * `FALLBACK_DEFAULT_SLUG`.
 *
 * Codex review fix (r1 P2): blended hints like `"Odin/Thoth/Padmasambhava"`
 * (which the interview's archetype_blend produces) used to bypass every
 * canonical-slug match because the whole string was passed verbatim to
 * the alias map, so blended hints always fell through to the default.
 * The fix below splits on slash / pipe / comma / `+` / `&`, then walks
 * each fragment in order — first canonical match wins. Single-name
 * hints behave exactly as before.
 */
export function normalizeArchetype(hint: string | undefined): FallbackArchetypeSlug {
  if (hint === undefined) return FALLBACK_DEFAULT_SLUG
  const fragments = hint
    .split(/[/|,+&]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const frag of fragments) {
    const slug = matchFragment(frag)
    if (slug !== null) return slug
  }
  return FALLBACK_DEFAULT_SLUG
}

function matchFragment(fragment: string): FallbackArchetypeSlug | null {
  const norm = fragment.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (norm.length === 0) return null
  if (isFallbackSlug(norm)) return norm
  const aliases: Record<string, FallbackArchetypeSlug> = {
    'gandalf': 'gandalf-the-white',
    'sherlock': 'sherlock-holmes',
    'marcus': 'marcus-aurelius',
    'da-vinci': 'da-vinci',
    'leonardo': 'da-vinci',
    'leonardo-da-vinci': 'da-vinci',
    'marie-curie': 'curie',
    'padma': 'padmasambhava',
    'guru-rinpoche': 'padmasambhava',
    // T5 (Codex r7 P2): the curated archetype library's display_name
    // for `musashi` is "Miyamoto Musashi" — without these aliases a
    // user who picked Musashi would degrade to the default portrait
    // because archetype_hint now lands as the human-readable
    // display_label (Codex r7's revert of r3's slug-joined hint).
    'miyamoto-musashi': 'musashi',
    'miyamoto': 'musashi',
  }
  return aliases[norm] ?? null
}
