/**
 * @neutronai/landing — mobile install-page configuration (ISSUES #208).
 *
 * Single source of truth for the native-store links the `/mobile`
 * install page renders. The Expo app in `app/` is NOT published to any
 * store yet (EAS binding is a pending operator step — see app/README),
 * so all three constants ship EMPTY. The page renders empty entries as
 * greyed, clearly-labeled "coming soon" placeholders and NEVER fabricates
 * a store URL.
 *
 * Flipping a store live is a one-line change: paste the real URL into
 * the constant below and the next deploy renders it as a live link —
 * no markup or route changes needed. (Native distribution itself — EAS
 * build + TestFlight / Play submission — is a separate operator step
 * requiring Sam's Apple/Google developer accounts.)
 */

import { escapeHtml } from './markdown.ts'

/** App Store product URL (e.g. https://apps.apple.com/app/idNNNNNNN). Empty = coming soon. */
export const APP_STORE_URL = ''

/** Google Play product URL (e.g. https://play.google.com/store/apps/details?id=computer.neutron.app). Empty = coming soon. */
export const PLAY_STORE_URL = ''

/** TestFlight public-beta invite URL. Empty = the beta row is hidden entirely. */
export const TESTFLIGHT_URL = ''

export interface MobileInstallLinks {
  app_store_url: string
  play_store_url: string
  testflight_url: string
}

export const MOBILE_INSTALL_LINKS: MobileInstallLinks = {
  app_store_url: APP_STORE_URL,
  play_store_url: PLAY_STORE_URL,
  testflight_url: TESTFLIGHT_URL,
}

/** Token in mobile.html the server replaces with the rendered store rows. */
export const STORE_LINKS_TOKEN = '<!--NEUTRON_STORE_LINKS-->'

function storeRow(label: string, url: string): string {
  if (url === '') {
    return (
      `<span class="store store--soon" aria-disabled="true">` +
      `<strong>${label}</strong><em>coming soon</em></span>`
    )
  }
  // escapeHtml (landing/markdown.ts) covers attribute context too — the
  // constants are operator-authored, but escaping keeps a pasted URL
  // with `&` query params valid and the renderer safe by construction.
  return (
    `<a class="store" href="${escapeHtml(url)}" rel="noopener">` +
    `<strong>${label}</strong><em>open</em></a>`
  )
}

/**
 * Server-side render of the `/mobile` page: replaces the
 * `STORE_LINKS_TOKEN` comment with the store rows. App Store + Google
 * Play always render (live link or greyed coming-soon); TestFlight only
 * renders when a beta URL is configured. Pure function so the
 * empty-vs-filled flip is unit-testable without a server.
 */
export function renderMobileInstallHtml(
  template: string,
  links: MobileInstallLinks = MOBILE_INSTALL_LINKS,
): string {
  const rows = [
    storeRow('App Store', links.app_store_url),
    storeRow('Google Play', links.play_store_url),
  ]
  if (links.testflight_url !== '') {
    rows.push(storeRow('TestFlight beta', links.testflight_url))
  }
  // Function replacer — the string form interprets `$&` / `$'` / `$$`
  // in the replacement as substitution patterns, so an operator-pasted
  // store URL containing a `$` sequence would silently splice template
  // text into the rendered page.
  return template.replace(STORE_LINKS_TOKEN, () => rows.join('\n'))
}
