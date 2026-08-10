/**
 * WHICH ACCOUNT is the credential on disk? A name, when something can supply one.
 *
 * The usage series records a reading a minute and has always left `account_label`
 * null, because this instance genuinely cannot tell one subscription from another:
 * whatever swaps `.credentials.json` does so from OUTSIDE the process, and the token
 * itself carries no account name. So an owner rotating between several accounts sees
 * one continuous graph made of readings from different subscriptions, which is worse
 * than useless — it averages away the exact thing they are trying to watch.
 *
 * This reads an OPTIONAL sidecar written by whatever does the swapping:
 *
 *   <same dir as .credentials.json>/.credentials.meta.json
 *   { "label": "acct-2", "fingerprint": "<first 12 hex of sha256(token)>" }
 *
 * ── THE FINGERPRINT IS THE WHOLE DESIGN ──────────────────────────────────────
 * The label is used ONLY when its fingerprint matches the token actually resolved.
 * Without that check a sidecar left behind by a previous swap would attach the
 * WRONG account's name to a real reading — and a confidently wrong label is far
 * worse than no label, because the owner would move quota away from an account
 * that was never the one under load. A mismatch is silently treated as "no label",
 * which renders as "active credential", which is true.
 *
 * It also means a writer cannot half-succeed: install a token without updating the
 * sidecar and the labels simply stop appearing, rather than going stale invisibly.
 *
 * ── WHY THE SIDECAR AND NOT AN API ───────────────────────────────────────────
 * Same reasoning as reading `.credentials.json` itself. A hosting layer, a shell
 * script, or a self-hoster's own cron can all write one small file next to the
 * credential they just installed. Requiring an HTTP call would mean the rotator
 * needs to know this instance's port, bearer token and readiness — three things it
 * currently does not need — to deliver one string.
 *
 * NOTHING HERE IS REQUIRED. No sidecar is the normal case, and it is not an error.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Sidecar filename, beside whichever `.credentials.json` is in play. */
const META_BASENAME = '.credentials.meta.json'

/**
 * A short, non-reversible fingerprint of a token.
 *
 * 12 hex characters of sha256 — enough that two live tokens colliding is not a
 * thing that happens, short enough to sit in a JSON file a human may read, and
 * NOT the token, so the sidecar never becomes a second copy of the secret. A
 * writer must produce exactly this or its label is ignored.
 */
export function credentialFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Where the sidecar lives, given the credentials file it describes.
 *
 * Takes the PATH rather than the env, so this module does not import
 * `active-credential.ts` — which imports this one, and the layering gate correctly
 * refused the cycle. It also reads better: the sidecar's location is defined by the
 * credential it sits beside, not by how that credential happened to be discovered.
 */
export function credentialLabelPath(credentialsPath: string): string {
  return join(dirname(credentialsPath), META_BASENAME)
}

export interface CredentialLabelDeps {
  /** Injected so tests never touch the runner's real home directory. */
  readFile?: (path: string) => string
}

/** Longest label worth carrying. A long one is a mistake, not a name. */
const MAX_LABEL_LENGTH = 64

/**
 * The label for `token`, or null.
 *
 * Null for every ordinary reason — no sidecar, unreadable, malformed, no label,
 * or a fingerprint describing a different token. NEVER throws and never guesses:
 * every failure path is the same answer, because the surfaces that render this
 * have exactly one way to say "we don't know which account this is".
 */
export function readCredentialLabel(
  credentialsPath: string,
  token: string,
  deps: CredentialLabelDeps = {},
): string | null {
  const read = deps.readFile ?? ((p: string): string => readFileSync(p, 'utf8'))
  let raw: string
  try {
    raw = read(credentialLabelPath(credentialsPath))
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as { label?: unknown; fingerprint?: unknown }
  const label = rec.label
  const fingerprint = rec.fingerprint
  if (typeof label !== 'string' || typeof fingerprint !== 'string') return null
  const trimmed = label.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) return null
  // The load-bearing line. A sidecar describing a token we are not holding is
  // stale, and a stale label is a confident lie about where the quota went.
  if (fingerprint !== credentialFingerprint(token)) return null
  return trimmed
}
