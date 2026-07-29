/**
 * @neutronai/app — client-side redaction for diagnostic reports (pure).
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * No credential ever enters a diagnostic report. Not the session bearer, not a
 * header dump, not a `dev:` token, not an OAuth code — nothing. This is not a
 * nicety: ISSUES #395 was a bug where the bearer was rendered as the account
 * display name and ended up in a screenshot. A crash reporter that captured
 * that same token and shipped it to a log file would be a strictly worse
 * version of that bug, because the token would then be at rest, in plain text,
 * in a file whose entire purpose is to be read and pasted around.
 *
 * TWO MECHANISMS, BECAUSE ONE IS NOT ENOUGH
 * -----------------------------------------
 *   1. EXACT-VALUE scrub. Callers pass the credentials they actually hold (the
 *      live bearer). Any occurrence is removed, anywhere, in any encoding-free
 *      form. This rule cannot produce a false negative for the token we know
 *      about, whatever shape it has.
 *   2. PATTERN scrub. Catches credentials this process does not hold — a token
 *      from an earlier session baked into a captured stack frame, an API key a
 *      Core echoed into an error message, a `?token=` in a URL. Keyed by both
 *      the KEY name (an `authorization` field is redacted whatever its value
 *      looks like) and the VALUE shape (JWT, bearer prefix, long opaque run).
 *
 * The gateway runs its own independent pass on arrival
 * (`gateway/diagnostics/client-report-redaction.ts`) so the host is protected
 * even from a client that is old, modified, or wrong. The duplication is the
 * design: this layer keeps the token off the wire and out of the device's
 * persisted queue; that layer keeps it off the operator's disk.
 *
 * PURE — no React, no React Native, no Expo. Unit-tested directly under
 * `bun test` (`app/__tests__/diagnostic-redact.test.ts`).
 */

/** The placeholder every redacted value collapses to. */
export const REDACTED = '[redacted]';

export const MAX_STRING_CHARS = 2000;
export const MAX_STACK_CHARS = 8000;
export const MAX_CONTEXT_KEYS = 24;
export const MAX_CONTEXT_DEPTH = 4;
export const MAX_ARRAY_ITEMS = 24;

/**
 * Keys whose VALUE is a credential regardless of what it looks like. Matched
 * case-insensitively as a substring so `Authorization`, `x-api-key`,
 * `refreshToken`, `session_secret` and `Cookie` all hit.
 */
const SECRET_KEY_RE =
  /(authorization|bearer|token|secret|password|passwd|api[-_]?key|apikey|credential|cookie|session[-_]?id|jwt|signature|private[-_]?key)/i;

/** `Authorization: Bearer <x>` / `bearer <x>` anywhere in free text. */
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** A three-segment JWT. */
const JWT_RE = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/** A base64url JSON header — a JWT's leading segment, still recognisable even
 *  when something upstream already truncated the rest of the token. */
const JWT_SEGMENT_RE = /\beyJ[A-Za-z0-9_-]{6,}/g;

/** The dev-lane opaque token the app accepts (`dev:<user_id>`), which IS a
 *  working bearer against a dev gateway — see `lib/auth.ts:signInWithDevToken`. */
const DEV_TOKEN_RE = /\bdev:[A-Za-z0-9._~-]+/g;

/** `token=<x>` / `"secret": "<x>"` / `api_key: <x>` inside free text — the shape
 *  a serialised request or query string takes once it is inside an error
 *  message and is no longer a structured object. */
const KEYED_VALUE_RE =
  /((?:authorization|bearer|token|secret|password|passwd|api[-_]?key|apikey|credential|cookie|jwt)"?\s*[:=]\s*"?)([^\s",;&}]+)/gi;

/** An opaque high-entropy run — the last net, for a credential format nothing
 *  above anticipated. 40 chars is deliberately long: real stack frames, file
 *  paths and identifiers stay under it, so this does not shred diagnostics. */
const OPAQUE_RUN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

/** Truncate with an explicit marker, so a reader never mistakes a trimmed
 *  value for the whole value. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…[truncated ${input.length - max} chars]`;
}

/**
 * Scrub one string: exact secrets first, then the pattern rules.
 *
 * Secrets shorter than 8 characters are skipped — below that a "secret" is
 * indistinguishable from ordinary prose, and blanket-replacing it would corrupt
 * the report for no security gain.
 */
export function redactString(input: string, secrets: readonly string[] = []): string {
  let out = input;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  out = out.replace(BEARER_RE, `bearer ${REDACTED}`);
  out = out.replace(KEYED_VALUE_RE, (_match, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(JWT_SEGMENT_RE, REDACTED);
  out = out.replace(DEV_TOKEN_RE, REDACTED);
  out = out.replace(OPAQUE_RUN_RE, REDACTED);
  return out;
}

/**
 * Recursively scrub an arbitrary JSON-ish value: redact by key, redact by
 * content, bound depth / breadth / length. Anything not representable in JSON
 * (a function, a symbol, `undefined`) is dropped — nothing a reader needs, and
 * one less way for an exotic value to smuggle state through.
 */
export function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return truncate(redactString(value, secrets), MAX_STRING_CHARS);
  if (Array.isArray(value)) {
    if (depth >= MAX_CONTEXT_DEPTH) return REDACTED;
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_CONTEXT_DEPTH) return REDACTED;
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (seen >= MAX_CONTEXT_KEYS) break;
      seen += 1;
      const safeKey = truncate(key, 64);
      // A secret KEY is redacted whatever its value looks like — this is the
      // rule that catches a captured `authorization` header, whose value reads
      // as an ordinary string once the token is short.
      out[safeKey] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(item, secrets, depth + 1);
    }
    return out;
  }
  return undefined;
}

/** Scrub a context bag, returning a plain object (never `undefined` members). */
export function redactContext(
  context: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  return redactValue(context, secrets, 0) as Record<string, unknown>;
}

/** Scrub a stack trace — same rules, a longer budget (frames are the payload). */
export function redactStack(stack: string, secrets: readonly string[]): string {
  return truncate(redactString(stack, secrets), MAX_STACK_CHARS);
}
