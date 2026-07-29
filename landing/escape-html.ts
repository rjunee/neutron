/**
 * @neutronai/landing — HTML-escaping primitive.
 *
 * Split out of the (now-deleted) chat-bubble markdown renderer
 * (`landing/markdown.ts`, ISSUES #116) during the wave-1 dead-code kill
 * (refactor plan §K1): `renderMarkdown` had zero non-test importers, but
 * `escapeHtml` is still live — `landing/mobile-install-config.ts` uses it
 * to escape operator-authored store URLs before interpolating them into
 * an HTML attribute.
 */

/** HTML-escape the five significant characters. Callers must run this
 *  BEFORE introducing any markup around the result (escape-then-format). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
