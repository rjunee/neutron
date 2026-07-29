/**
 * @neutronai/app — doc-link helper (P7.3) — L6 re-export shim + app-only router helper.
 *
 * Before L6 this file was a ~490-line BYTE-TWIN of `runtime/doc-links.ts` (the
 * `docs:/…` marker ⇄ channel-URL algorithm), duplicated so the Expo bundle
 * could avoid `@neutronai/runtime`'s transitive node-only deps. L6 moved that
 * algorithm into the node-free `@neutronai/wire-types` leaf (the ONE source);
 * this file now RE-EXPORTS it and keeps ONLY the Expo-router-specific
 * `docLinkToRouterPath` projection below.
 *
 * The web-app base env asymmetry that used to be this file's only real
 * difference (`EXPO_PUBLIC_NEUTRON_WEB_APP_BASE` here vs `NEUTRON_WEB_APP_BASE`
 * in the runtime) is preserved EXPLICITLY inside the shared `webAppBase()` — it
 * resolves `NEUTRON_WEB_APP_BASE ?? EXPO_PUBLIC_NEUTRON_WEB_APP_BASE`, so the
 * Expo bundle (which only inlines `EXPO_PUBLIC_`-prefixed vars) still gets its
 * value. See `wire-types/doc-links.ts`.
 *
 * `app/` may import `@neutronai/wire-types` — it's a node-free contracts-band
 * leaf, so the `app-bundle-purity` depcruise rule allows it (that rule only
 * forbids reaching gateway/runtime/persistence/channels/… server workspaces).
 */

import type { ParsedDocLink } from '@neutronai/wire-types/doc-links.ts'

export * from '@neutronai/wire-types/doc-links.ts'

/**
 * Expo-router-only projection: map a {@link ParsedDocLink} onto the in-app docs
 * route (`/projects/<id>/docs?path=…[&line|&range]`). Returns `null` for a
 * vault-legacy ref (no project scope → no in-app route). App-specific, so it
 * stays here rather than in the shared leaf.
 *
 * P7.3 — a `line` anchor appends `&line=<n>`; a `range_start`+`range_end`
 * anchor appends `&range=<n>-<m>`. `line` and `range` are mutually exclusive
 * (the parser rejects same-URL pairings); if both somehow arrive, `line` wins
 * for symmetry with the parser's precedence guard.
 */
export function docLinkToRouterPath(parsed: ParsedDocLink): string | null {
  if (parsed.project_id === null) return null
  const encodedPath = encodeURIComponent(parsed.path)
  let target = `/projects/${parsed.project_id}/docs?path=${encodedPath}`
  if (parsed.line !== undefined) {
    target += `&line=${parsed.line}`
  } else if (parsed.range_start !== undefined && parsed.range_end !== undefined) {
    target += `&range=${parsed.range_start}-${parsed.range_end}`
  }
  return target
}
