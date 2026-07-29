/**
 * @neutronai/persistence — the branded `OwnerHandle` identity type.
 *
 * ── Why this exists (the 2026-05-12 credential-loss incident) ────────────────
 * The codebase has a dangerous identifier ambiguity. The value carried under
 * the name `project_slug` (~6.5k refs) does NOT mean "a project"; it means the
 * OWNER / INSTANCE identity — and it exists in TWO forms that are byte-equal at
 * provisioning time but DIVERGE after a rename:
 *
 *   - `owner_handle` (a.k.a. the frozen `internal_handle`) — the IMMUTABLE
 *     registry PK, locked at provisioning time. This is the credential key.
 *   - `url_slug` (a.k.a. the mutable `owner_slug` on the URL axis) — the
 *     user-facing slug that CHANGES when the owner renames their instance.
 *
 * On 2026-05-12 a caller passed the MUTABLE `url_slug` where the FROZEN handle
 * was required. After a rename the two strings differed, so every credential
 * row — written at the ORIGINAL handle — became invisible: Max OAuth + BYO API
 * key reads silently returned null and the chat surface dropped to the gate
 * page. No error, no log — a silent, total credential loss. See
 * `auth/secrets-store.ts:10-27` for the store-level rationale and
 * `persistence/AGENTS.md` § "Identity glossary" for the full contract.
 *
 * ── What the brand buys ──────────────────────────────────────────────────────
 * `OwnerHandle` is a TypeScript NOMINAL brand over `string`: it is still a
 * plain string at runtime (zero cost, no wrapper) but the compiler refuses to
 * accept a bare `string` (an un-vetted, possibly-mutable slug) where an
 * `OwnerHandle` is demanded. The credential store boundaries
 * (`SecretsStore`, `ApiKeyStore`, `ProjectCredentialStore`) key on
 * `OwnerHandle`, so re-introducing the 2026-05-12 bug — feeding a raw
 * `url_slug` to a credential lookup — is now a COMPILE ERROR, not a silent
 * production outage.
 *
 * ── How to use ───────────────────────────────────────────────────────────────
 * Call `asOwnerHandle(s)` ONCE, at the point where the string is first known to
 * be the frozen registry handle (resolved from auth / the registry row), then
 * thread the branded value to the credential boundary. NEVER call
 * `asOwnerHandle` on a value you know to be a `url_slug`; that is exactly the
 * bug the brand exists to prevent.
 */

/**
 * The frozen, immutable owner/instance identity — the credential key.
 *
 * Nominal brand: assignable FROM nothing but `asOwnerHandle`, and a bare
 * `string` is NOT assignable to it. Erases to `string` at runtime.
 */
export type OwnerHandle = string & { readonly __brand: 'OwnerHandle' }

/**
 * Brand a string as the frozen `OwnerHandle`. Call this ONLY where the value is
 * known-good — i.e. it is the immutable `internal_handle` resolved from the
 * registry / auth, NOT a mutable `url_slug`. This is the single trusted
 * constructor; everything downstream threads the branded value.
 */
export function asOwnerHandle(s: string): OwnerHandle {
  return s as OwnerHandle
}
