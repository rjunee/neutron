# AGENTS.md — persistence

This module owns the per-project SQLite layer: `ProjectDb.open(path)` opens a `bun:sqlite` connection with the locked PRAGMA set (WAL + FK + synchronous=NORMAL + temp_store=MEMORY + cache_size=-64000 + busy_timeout=100), exposes prepared-statement / `transaction()` / `pragma()` wrappers plus typed `get` / `all` reads, a sync `runSync` returning the driver's `{ changes, lastInsertRowid }`, and an opt-in `assertInTransaction()` for store methods that require a caller-held transaction (all behavior-identical to the `raw()` calls they replace — see the in-module docs for serialization caveats), routes writes through the jittered busy-retry helper in `retry.ts` (15 retries, 20–100 ms jitter, async via `await Bun.sleep` so the gateway watchdog tick keeps firing during contention), and serialises all `run` / `exec` / `transaction` calls on a per-instance async mutex so a concurrent caller cannot leak into an open BEGIN/COMMIT window. Algorithmic shape ports from Hermes `hermes_state.py:115-130` (internal design notes § 2 lift target); concurrency tuning constants tightened from Hermes' Python defaults — rationale in `retry.ts` head comment.

`sidecar.ts` (refactor P3) is the sanctioned open path for the repo's raw-`bun:sqlite` sidecar databases (doc-search index, comments store, binary-blob index, calendar/email/code-gen/research per-project sidecars): `openSidecar(path, opts)` applies the same `STARTUP_PRAGMAS` set as `ProjectDb.open` and returns the raw `Database` handle (busy-retry stays opt-in — sidecar writers are synchronous; the C-level `busy_timeout` pragma always applies). It also carries the shared store helpers: `parseJsonColumn` (JSON codec with an EXPLICIT per-call-site corrupt-policy — `'throw'` / `'fallback'` / `'raw'`; the three divergent historical policies are deliberately NOT unified), `mapRow`/`mapRows` (row decode), and `resolveNow` (injectable-clock seam). A new sidecar must open through `openSidecar` and state its corrupt-JSON policy explicitly. (FK note: every adopting sidecar is already FK-enforced today — the migration-runner sidecars go through `applyMigrations`, which asserts `PRAGMA foreign_keys = ON`, and the inline-schema sidecars set it explicitly — so `openSidecar`'s FK=ON is behavior-preserving.)

It must NOT contain schema definitions (those live in `migrations/`), instance routing (gateway), or any per-table query helpers. Higher-level callers (gateway, runtime, scribe, gbrain-memory adapter, reminders) compose this module's primitives — they don't bypass it to touch `bun:sqlite` directly (raw sidecar stores go through `openSidecar`).

Cross-refs: `docs/engineering-plan.md § B.P1`, `docs/plans/instance-boundary-spec.md`, internal design notes.

## Identity glossary — `owner_handle` vs `url_slug` vs `project_id` (READ BEFORE keying any credential store)

There is a load-bearing ambiguity in this codebase: the identifier written under
the name **`project_slug`** (~6.5k refs) does **not** mean "a project". It means
the **owner / instance identity**, and it comes in two forms that are byte-equal
at provisioning time but **diverge after a rename**. Confusing the two silently
destroys credentials (see the incident below). Three distinct concepts:

- **`owner_handle`** — the **FROZEN, IMMUTABLE** instance/owner identity: the
  registry row's PK, locked at provisioning time and never changed. Historically
  called **`internal_handle`**; the SQL columns that store it are still literally
  named `project_slug` / `owner_slug` (no migration — the value is just a string).
  **This is the credential key.** Represented in TypeScript by the branded type
  `OwnerHandle` (`persistence/owner-handle.ts`), constructed with `asOwnerHandle`.
- **`url_slug`** (a.k.a. the mutable `owner_slug` on the URL/routing axis) — the
  **MUTABLE, user-facing** slug. It CHANGES when the owner renames their instance.
  Legitimately used for cross-instance API calls, DNS, and Caddy/route mapping.
  It is a plain `string` and is **NEVER** a credential key.
- **`project_id`** — a **real project WITHIN an instance** (the per-project axis
  of `project_credentials`; `''` is the global-scope sentinel). Orthogonal to the
  owner identity: `project_credentials` rows are keyed on `(owner_handle,
  project_id, service)` — the owner boundary is the frozen handle, the project
  dimension is the real project id.

### The 2026-05-12 credential-loss incident

A caller passed the **mutable `url_slug`** where the **frozen `owner_handle`** was
required. At provisioning the two strings were identical, so it worked. After an
instance rename they diverged: the gateway canonicalised `project_slug` to the
row's NEW `url_slug`, but every secret row had been written under the ORIGINAL
handle. The lookups keyed on the new slug matched nothing — **Max OAuth + BYO API
key reads silently returned `null`**, dropping the chat surface to the gate page
even though the tokens were still on disk. No error, no log. See
`auth/secrets-store.ts:10-27`.

### Prescriptive rule — which identifier to pass where

- **Any credential store — `SecretsStore`, `ApiKeyStore`, `ProjectCredentialStore`
  (and their wrappers: `OAuthTokenManager`, `MaxOAuthClient`, `ChatGPTOAuthClient`,
  `FederatedTokenStore`, the Cores secrets accessor, the Codex credential store) —
  MUST be keyed on the frozen `owner_handle`.** These boundaries type their
  identity parameter as `OwnerHandle`, so passing a bare `string` (a possibly-
  mutable `url_slug`) is a **compile error**, not a silent outage.
- **Construct an `OwnerHandle` exactly once, with `asOwnerHandle(s)`, at the point
  where the string is first known to be the frozen handle** — resolved from the
  registry / auth (e.g. `resolved.project_slug` from an auth token, or
  `input.project_slug` at the Cores mount seam) — then **thread the branded value**
  to the store. **NEVER** call `asOwnerHandle` on a value you know to be a
  `url_slug`; that re-introduces the exact bug the brand exists to prevent.
- **Routing / DNS / cross-instance HTTP** legitimately uses the mutable `url_slug`
  (a plain `string`). Anything that hits a credential store must not.

### Scope (N1 vs N2/N3) — what the brand does and does NOT guarantee

N1 brands the **credential store + wrapper boundaries** (above) and constructs the
`OwnerHandle` at each **known-good source** — the Cores mount seam, the bundled-
cores installer, the credential HTTP surfaces (`asOwnerHandle(resolved.project_slug)`,
at the point it is resolved from auth), and DB-read-back rows. The shared HTTP
auth-resolved types (`AppWsAuthResolved` / `ResolvedAuth`) and the ~6.5k
`project_slug` string fields across the boot/composition graph deliberately stay
plain `string`: threading the brand end-to-end through every one of them is the
**N2/N3 mass rename**, which N1 explicitly does not attempt.

**What N1 guarantees:** a raw `string` can never reach a credential store/wrapper
*by accident* — the type wall forces the wrong value to be branded through an
**explicit, greppable `asOwnerHandle(...)`** at a construction site a reviewer (and
N2/N3) can audit. `asOwnerHandle` is a compile-time cast, not a runtime validator
(a frozen handle and a mutable slug are indistinguishable strings), so it CANNOT
detect a mis-branded slug on its own.

**What N1 does NOT yet fix — the boot-slug conflation (an N2/N3 audit target):**
on the **Managed** platform, `gateway/index.ts:resolveOwnerSlug` resolves the boot
`project_slug` from the rename orchestrator's `.url_slug` file — i.e. the *mutable*
slug — and the ~6.5k-ref conflation means the *frozen* registry handle is not
separately threaded to composition. Every `asOwnerHandle(input.project_slug)` at a
composition seam (`mount-open-cores`, `wire-cores-surfaces`, `install-bundled`,
`integrations`, the Codex composer hook) therefore currently brands whatever the
boot slug is. These call sites are exactly the **audit targets** N2/N3 must re-point
at the frozen registry handle. On **Open** (this product) there is no rename
machinery — `internal_handle === url_slug` always (`open/owner-identity.ts`) — so
these sites are correct today; the brand's job here is to make the Managed re-plumb
a mechanical, greppable follow-up rather than a silent hazard.
