/**
 * @neutronai/gateway/projects — deterministic default project emoji.
 *
 * Every project shows an emoji in the redesigned rail. When the owner hasn't
 * chosen one explicitly, we pick a sensible DEFAULT from the project name so a
 * fresh project already reads at a glance ("Fitness plan" → 🏋️, "Read more
 * books" → 📚). The pick is PURE + DETERMINISTIC (no LLM, no randomness) so:
 *   - the same name always maps to the same glyph (stable across reloads, and
 *     unit-testable without stubbing a clock/RNG), and
 *   - it runs cheaply at project-create time AND at serve time (to backfill
 *     legacy rows whose `emoji` column is NULL) without a network hop.
 *
 * Strategy: a keyword table maps common project themes to a fitting glyph; if
 * no keyword matches, a stable string hash indexes a curated fallback palette
 * so distinct names still get visually distinct (but consistent) glyphs.
 *
 * This is intentionally a heuristic, not an exhaustive classifier — the owner
 * can always override it in the Settings tab. Keep the keyword list short and
 * high-signal rather than trying to cover every word.
 */

/** The General (no-project) scope's fixed default glyph. */
export const GENERAL_EMOJI = '💬'

/** Generic fallback when a name is empty/unusable and no palette pick applies. */
const GENERIC_EMOJI = '📁'

/**
 * Keyword → emoji. Ordered most-specific-ish first; the first substring hit
 * wins. Lowercased word-boundary-ish matching (we test substring against the
 * lowercased name, which is fine for these high-signal stems).
 */
const KEYWORD_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['fitness', '🏋️'],
  ['workout', '🏋️'],
  ['gym', '🏋️'],
  ['run', '🏃'],
  ['marathon', '🏃'],
  ['yoga', '🧘'],
  ['medit', '🧘'],
  ['health', '🩺'],
  ['doctor', '🩺'],
  ['book', '📚'],
  ['read', '📚'],
  ['study', '📖'],
  ['learn', '🎓'],
  ['course', '🎓'],
  ['school', '🎓'],
  ['language', '🗣️'],
  ['spanish', '🗣️'],
  ['french', '🗣️'],
  ['write', '✍️'],
  ['writing', '✍️'],
  ['novel', '✍️'],
  ['blog', '✍️'],
  ['journal', '📓'],
  ['code', '💻'],
  ['coding', '💻'],
  ['dev', '💻'],
  ['program', '💻'],
  ['software', '💻'],
  ['app', '📱'],
  ['website', '🌐'],
  ['web', '🌐'],
  ['design', '🎨'],
  ['art', '🎨'],
  ['paint', '🎨'],
  ['draw', '✏️'],
  ['photo', '📷'],
  ['video', '🎬'],
  ['film', '🎬'],
  ['movie', '🎬'],
  ['music', '🎵'],
  ['song', '🎵'],
  ['guitar', '🎸'],
  ['piano', '🎹'],
  ['podcast', '🎙️'],
  ['game', '🎮'],
  ['gaming', '🎮'],
  ['travel', '✈️'],
  ['trip', '✈️'],
  ['vacation', '🏖️'],
  ['flight', '🛫'],
  ['food', '🍳'],
  ['cook', '🍳'],
  ['recipe', '🍳'],
  ['baking', '🧁'],
  ['coffee', '☕'],
  ['garden', '🌱'],
  ['plant', '🪴'],
  ['home', '🏠'],
  ['house', '🏠'],
  ['move', '📦'],
  ['moving', '📦'],
  ['clean', '🧹'],
  ['money', '💰'],
  ['budget', '💰'],
  ['finance', '💰'],
  ['invest', '📈'],
  ['saving', '🏦'],
  ['tax', '🧾'],
  ['work', '💼'],
  ['business', '💼'],
  ['startup', '🚀'],
  ['launch', '🚀'],
  ['career', '💼'],
  ['job', '💼'],
  ['meeting', '📅'],
  ['plan', '🗺️'],
  ['goal', '🎯'],
  ['idea', '💡'],
  ['research', '🔬'],
  ['science', '🔬'],
  ['data', '📊'],
  ['ai', '🤖'],
  ['robot', '🤖'],
  ['car', '🚗'],
  ['bike', '🚴'],
  ['cycl', '🚴'],
  ['dog', '🐶'],
  ['cat', '🐱'],
  ['pet', '🐾'],
  ['baby', '🍼'],
  ['kid', '🧸'],
  ['family', '👨‍👩‍👧'],
  ['wedding', '💍'],
  ['party', '🎉'],
  ['event', '🎉'],
  ['birthday', '🎂'],
  ['shop', '🛍️'],
  ['store', '🏬'],
  ['fashion', '👗'],
  ['sport', '⚽'],
  ['soccer', '⚽'],
  ['football', '🏈'],
  ['basketball', '🏀'],
  ['climb', '🧗'],
  ['hik', '🥾'],
  ['fish', '🎣'],
  ['news', '📰'],
  ['note', '📝'],
  ['task', '✅'],
  ['todo', '✅'],
  ['neutron', '⚛️'],
]

/**
 * A curated palette of neutral-but-distinct glyphs for the hash fallback. Kept
 * free of the strongly-themed glyphs above so a hashed pick reads as "a
 * project" rather than mis-signalling a theme.
 */
const PALETTE: ReadonlyArray<string> = [
  '📁',
  '📌',
  '🗂️',
  '📒',
  '🧭',
  '🔖',
  '🧩',
  '⭐',
  '🌟',
  '🔷',
  '🟣',
  '🟢',
  '🟠',
  '🔶',
  '🌀',
  '✨',
]

/** Stable, order-sensitive 32-bit string hash (FNV-1a). Deterministic. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Pick a deterministic default emoji for a project from its display name
 * (falls back to the id when the name is empty). First keyword hit wins;
 * otherwise a stable hash indexes the neutral palette.
 */
export function defaultProjectEmoji(nameOrId: string): string {
  const name = (nameOrId ?? '').trim()
  if (name.length === 0) return GENERIC_EMOJI
  const lower = name.toLowerCase()
  for (const [kw, glyph] of KEYWORD_EMOJI) {
    if (lower.includes(kw)) return glyph
  }
  const idx = hashString(lower) % PALETTE.length
  return PALETTE[idx] ?? GENERIC_EMOJI
}

/**
 * Max length (in UTF-16 code units) accepted for a user-supplied emoji. One
 * emoji can be several code points (ZWJ sequences, skin-tone modifiers, flags),
 * so this is generous but still bounds a paste of arbitrary text. The write
 * paths (PATCH surface + agent tool) reject anything longer.
 */
export const MAX_EMOJI_LEN = 16

/**
 * Validate + normalise a user-supplied emoji for storage. Returns the trimmed
 * string when acceptable, or null when it should be rejected. Intentionally
 * permissive about WHICH grapheme (we can't reliably prove "is exactly one
 * emoji" without a full grapheme segmenter), but bounds the length so the field
 * can't be abused to smuggle a paragraph of text into the rail.
 */
export function normaliseEmojiInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_EMOJI_LEN) return null
  // Reject plain ASCII letters/digits — those are clearly not an emoji and are
  // the most common "typed a word by mistake" input. Allow any non-ASCII
  // grapheme (covers the whole emoji range without enumerating it).
  if (/^[\x00-\x7F]+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Resolve the emoji to display for a project: the explicitly-stored value when
 * present + non-empty, otherwise the deterministic default from the name. Used
 * at every serve-time seam so a legacy row (NULL emoji) still shows a glyph.
 */
export function resolveProjectEmoji(stored: string | null | undefined, nameOrId: string): string {
  if (typeof stored === 'string' && stored.trim().length > 0) return stored
  return defaultProjectEmoji(nameOrId)
}
