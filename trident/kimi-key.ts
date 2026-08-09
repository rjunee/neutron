/**
 * Where the Kimi K3 API key comes from — env, or the owner's stored credential.
 *
 * WHY THIS EXISTS. The K3 cross-model reviewer only ever read
 * `process.env.KIMI_API_KEY`, which means a self-hoster could not turn it on at
 * all: there is no supported way to set a gateway env var from inside the product,
 * so the second model family in the review panel was reachable only by whoever
 * could edit the service unit. The owner asked for the key to be enterable in
 * Open's settings before cutover (SPEC Decisions Log 2026-08-07). Settings already
 * stores arbitrary per-service credentials; nothing read one for Kimi.
 *
 * THE STORE IS THE ONLY SOURCE (owner-directed, 2026-08-09). This module briefly
 * read an env var first, as a migration convenience; that made the env a second
 * resolution path, which silently beat anything the owner typed into settings. Now
 * `KIMI_API_KEY` is only ever an OUTPUT — the channel the resolved key travels to
 * the child on — never an input.
 *
 * THE KEY IS NEVER RETURNED INTO A PROMPT. `resolve_kimi_configured` converts it
 * to a BOOLEAN before it crosses into the workflow, and the reviewer subprocess
 * reads the value from its own environment. That property is the reason the
 * plumbing looks indirect, and it must survive any change here: a key in an
 * `agent()` prompt is a key in a transcript, a log line, and a chat message.
 */

/** The credential-store service id an owner files their Kimi key under. */
export const KIMI_CREDENTIAL_SERVICE = 'kimi'

/** The environment variable the reviewer subprocess reads. */
export const KIMI_API_KEY_ENV = 'KIMI_API_KEY'

/**
 * The stored-credential lookup, narrowed to the one call this needs so the
 * resolver stays testable without a database. Returns the decrypted key, or null.
 */
export interface KimiKeyLookup {
  (): string | null
}

/**
 * Resolve the key from the credential store. THE STORE IS THE ONLY SOURCE.
 *
 * THIS USED TO READ AN ENV VAR FIRST, and the owner removed that: *"we shouldn't be
 * using an env var at all — that was a temporary hack, not a production-grade
 * decision."* He is right, and the reason is structural rather than stylistic: an
 * env var that WINS over the store is a second resolution path, so the same
 * settings screen produces different behaviour on two boxes depending on how one
 * of them was provisioned. Worse, it fails silently in the direction nobody checks
 * — the owner pastes a new key, the screen says it is saved, and every review keeps
 * using the old one with nothing anywhere reporting a conflict. That is exactly the
 * no-dual-code-paths rule, applied to configuration.
 *
 * The env var is still how the CHILD receives the key (see
 * {@link ensureKimiKeyExported}) — that indirection is load-bearing and stays. What
 * is gone is env as a *source*: nothing reads `KIMI_API_KEY` to decide what the key
 * IS any more, only to hand the resolved one to a subprocess.
 *
 * A whitespace-only stored value counts as ABSENT, so a cleared field is "not
 * configured" rather than a key of length zero.
 */
export function resolveKimiApiKey(lookup: KimiKeyLookup | null): string | null {
  if (lookup === null) return null
  let stored: string | null
  try {
    stored = lookup()
  } catch {
    // A store read must never take down a review launch. An unreadable credential
    // is "not configured", which is the graceful path the panel already handles.
    return null
  }
  const fromStore = typeof stored === 'string' ? stored.trim() : ''
  return fromStore.length > 0 ? fromStore : null
}

/**
 * Resolve the key AND make sure the reviewer subprocess can see it, returning
 * whether K3 is configured at all.
 *
 * THE SIDE EFFECT IS THE POINT, and it is why this is not just `resolveKimiApiKey`
 * at the call site. `trident/kimi-review-cli.ts` runs in its own process and reads
 * `KIMI_API_KEY` from ITS environment — that indirection is what keeps the key out
 * of prompt text. A key that lives only in the credential store would therefore
 * resolve to `configured: true` and then fail in the child with "no key", which is
 * a worse outcome than not being configured at all: a deferred reviewer BLOCKS the
 * verdict, so every review would come back REQUEST_CHANGES for a reason the owner
 * cannot see. Exporting it here closes that gap at the one moment the answer is
 * needed.
 *
 * Called PER LAUNCH rather than at boot, so a key entered in settings takes effect
 * on the next run instead of the next restart.
 */
export function ensureKimiKeyExported(
  env: Record<string, string | undefined>,
  lookup: KimiKeyLookup | null,
): boolean {
  const key = resolveKimiApiKey(lookup)
  if (key === null) {
    // NOT CONFIGURED MEANS NOT CONFIGURED, so a stale env value is CLEARED rather
    // than left standing. Without this, deleting the key in settings would leave a
    // previously-exported value in the process environment and the reviewer would
    // keep running on a credential the owner believes they removed — the mirror
    // image of the bug this change exists to fix.
    if (env[KIMI_API_KEY_ENV] !== undefined) delete env[KIMI_API_KEY_ENV]
    return false
  }
  // Only write when it differs: a no-op assignment on every launch is noise.
  if (env[KIMI_API_KEY_ENV] !== key) env[KIMI_API_KEY_ENV] = key
  return true
}
