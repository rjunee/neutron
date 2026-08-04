/**
 * landing/chat-react — OAuth-account view-model for the web Admin tab.
 *
 * The web twin of the RN `app/lib/integrations-view.ts` label helpers, kept as a
 * separate pure module so the grouping/title logic unit-tests without a DOM
 * (same convention as `integrations-client.ts`: re-declared rather than imported
 * across the workspace boundary, so the browser bundle takes no Expo-app edge).
 *
 * ── Why grouping exists ─────────────────────────────────────────────────────
 * A Google OAuth grant label is COMPOSITE once a service holds more than one
 * account: `<service>#<account_key>`, where the key is a hash. `GET
 * /api/cores/integrations` returns ONE ROW PER CONNECTED ACCOUNT (see
 * `buildIntegrationsStatus` in gateway/cores/integrations.ts) and falls back to
 * a single bare `<service>` row when nothing is connected yet. So:
 *
 *   - the owner running three Google accounts sees three rows on one service,
 *     each independently disconnectable — the row's FULL label is what
 *     `POST /api/cores/oauth/google/disconnect/<label>` addresses;
 *   - CONNECT is addressed by the SERVICE, never the composite: `/start`
 *     validates `labels` against the manifest-declared slots
 *     (`collectKnownLabels` in gateway/http/cores-oauth-surface.ts), which are
 *     bare service names. Passing `google_calendar#a1b2c3` would 400
 *     `unknown_label`;
 *   - a service that ALREADY has accounts still needs a connect affordance, or
 *     the second and third account can never be added. That is the group-level
 *     "Add another account".
 *
 * Grouping by service is what makes all three expressible in one list.
 */

import type { OAuthAccountIntegration } from './integrations-client.ts'

/** The account-key separator in a composite grant label. Mirrors
 *  `ACCOUNT_KEY_SEPARATOR` in gateway/cores/oauth-token-manager.ts. */
const ACCOUNT_KEY_SEPARATOR = '#'

/**
 * The service half of a grant label. A label with no separator is a legacy
 * un-keyed grant (or a not-yet-connected placeholder) and is already the
 * service. Mirrors `parseGrantLabel` in gateway/cores/oauth-token-manager.ts.
 */
export function oauthService(label: string): string {
  const at = label.indexOf(ACCOUNT_KEY_SEPARATOR)
  return at < 0 ? label : label.slice(0, at)
}

/**
 * Human title for a service. The account key is a HEX DIGEST — rendering the
 * raw label would put `google_calendar#a1b2c3d4` in front of the owner, so the
 * key is stripped and the service humanised. The account itself is already
 * named on the row's status line ("Connected as …"), so it is not repeated.
 * Same transform as `oauthTitle` in app/lib/integrations-view.ts.
 */
export function oauthServiceTitle(label: string): string {
  return oauthService(label)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** One-line status for an account row. */
export function oauthAccountStatus(acc: OAuthAccountIntegration): string {
  if (!acc.connected) return 'Not connected'
  if (acc.email !== null && acc.email.length > 0) return `Connected as ${acc.email}`
  return 'Connected'
}

/** Every account row the server returned for one service, plus its identity. */
export interface OAuthServiceGroup {
  /** Bare service label — the value CONNECT must send to `/start`. */
  service: string
  /** Display title (`Google Calendar`); never a raw hex digest. */
  title: string
  /** Server-ordered rows for this service. Each row's `label` is the FULL
   *  (possibly composite) label DISCONNECT must address. */
  accounts: OAuthAccountIntegration[]
  /** How many of them are actually connected. */
  connectedCount: number
  /** Union of the Core slugs declaring this service, first-seen order. */
  coreSlugs: string[]
}

/**
 * Fold the flat `oauth[]` payload into one group per service, preserving the
 * server's ordering both across services and within one service's accounts.
 */
export function groupOAuthAccounts(
  rows: readonly OAuthAccountIntegration[],
): OAuthServiceGroup[] {
  const groups = new Map<string, OAuthServiceGroup>()
  for (const acc of rows) {
    const service = oauthService(acc.label)
    let group = groups.get(service)
    if (group === undefined) {
      group = {
        service,
        title: oauthServiceTitle(service),
        accounts: [],
        connectedCount: 0,
        coreSlugs: [],
      }
      groups.set(service, group)
    }
    group.accounts.push(acc)
    if (acc.connected) group.connectedCount += 1
    for (const slug of acc.core_slugs) {
      if (!group.coreSlugs.includes(slug)) group.coreSlugs.push(slug)
    }
  }
  return [...groups.values()]
}
