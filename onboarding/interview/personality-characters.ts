/**
 * @neutronai/onboarding/interview — static personality-character fallback
 * (extracted leaf, refactor unit K11a4).
 *
 * Split out of `personality-character-suggester.ts` (which remains the LIVE
 * suggester module — wired in `open/composer.ts`, depended on by
 * `engine-slug.ts`, typed in `build-landing-stack.ts`) so consumers that
 * only need the static fallback shape/constant (e.g.
 * `onboarding-preamble.ts`) don't have to import the full suggester
 * (LLM client types, prompt builders, envelope parser, etc). Zero imports —
 * this is a leaf.
 */

export interface CharacterSuggestion {
  /** Character name as the user will see it. Trimmed, ≤60 chars. */
  name: string
  /** One-line "why this character fits". Trimmed, ≤160 chars. */
  why: string
}

export interface PersonalityCharacterSuggestions {
  /** 3 picks personalized to the user's signals. */
  personalized: ReadonlyArray<CharacterSuggestion>
  /** 2 picks that are unexpected but still match at least one signal. */
  wild: ReadonlyArray<CharacterSuggestion>
}

/**
 * Back-compat constant — the original (monotone) fallback. Retained for
 * importers/tests that referenced it directly; the LIVE fallback path now
 * goes through `buildDiverseCharacterFallback(project_slug)` for per-instance
 * variety (male/female/neutral, serious/playful) so two fresh instances no
 * longer see the identical five male sages.
 */
export const STATIC_PERSONALITY_CHARACTER_FALLBACK: PersonalityCharacterSuggestions =
  {
    personalized: [
      { name: 'Sherlock Holmes', why: 'Sharp, observant, gets to the heart of a problem fast.' },
      { name: 'Marcus Aurelius', why: 'Steady, principled, calm under pressure.' },
      { name: 'Mr. Miyagi', why: 'Patient, clear, teaches by example.' },
    ],
    wild: [
      { name: 'Yoda', why: 'Cryptic but always right — makes you think.' },
      { name: 'Atticus Finch', why: 'Quiet conviction; the right thing, said plainly.' },
    ],
  }
