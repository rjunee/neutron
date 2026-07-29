/**
 * @neutronai/email-managed-core — app-tab UI-component metadata.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.1. The
 * manifest's `ui_components[1]` declaration points here. P5.3
 * launcher tiles whose `primary_action='open_app_tab'` navigate the
 * Expo Router to this surface's path.
 *
 * v1 ships pure declarative metadata — the actual app tab (Email UI
 * surface) is a P5.x sprint. Until that lands the runtime composer
 * has a stable shape to register against and the Expo Router can
 * 404-gracefully when the tile is tapped.
 */

export const APP_TAB_META = {
  path: '/projects/<project_id>/email',
  label: 'Email',
  emoji: '📬',
} as const

export type AppTabMeta = typeof APP_TAB_META
