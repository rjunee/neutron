/**
 * @neutronai/research-core — `app_tab` UI-component metadata.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.1 + § 4.
 *
 * Purely declarative — no runtime logic. The P5.3 launcher consumes
 * the manifest's `ui_components[].app_tab` block to register the tile-
 * tap navigation target. The actual app tab (research-browser UI
 * surface) is a P5.x sprint that mounts a React/RN component at
 * `/projects/<project_id>/research`.
 */

export interface ResearchAppTabSurface {
  readonly path: string
  readonly label: string
  readonly emoji: string
  /** Hint to the launcher / app shell about preferred sort order. */
  readonly ordering_hint: number
}

export const APP_TAB_SURFACE: ResearchAppTabSurface = {
  path: '/projects/<project_id>/research',
  label: 'Research',
  emoji: '\u{1F52C}',
  /** Tier 1 Cores ship with default ordering hints in a single tens-
   *  digit range; Research takes 60 so it slots after Notes (10),
   *  Tasks (20), Reminders (30), Calendar (40), and Email (50). */
  ordering_hint: 60,
}
