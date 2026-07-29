/**
 * @neutronai/runtime — doc-link helper (P7.3) — L6 re-export shim.
 *
 * The doc-link build/parse ALGORITHM moved to the node-free
 * `@neutronai/wire-types` leaf in L6 (it was a BYTE-TWIN duplicated in
 * `app/lib/doc-links.ts`, now deleted). This module is a thin re-export so
 * every existing `runtime/doc-links` / `@neutronai/runtime` importer stays
 * valid. The server-side web-app base env (`NEUTRON_WEB_APP_BASE`) is honored
 * by the shared `webAppBase()` — see `wire-types/doc-links.ts` for the one
 * asymmetric mapping (server `NEUTRON_WEB_APP_BASE` vs Expo
 * `EXPO_PUBLIC_NEUTRON_WEB_APP_BASE`) preserved explicitly there.
 */

export * from '@neutronai/wire-types/doc-links.ts'
