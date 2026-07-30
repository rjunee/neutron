/**
 * @neutronai/chat-core — the ONE random-id generator every client surface uses.
 *
 * WHY THIS FILE EXISTS. `crypto` IS NOT A GLOBAL IN THE MOBILE RUNTIME. React
 * Native 0.81 does not install one, and Expo SDK 54's WinterCG shim installs
 * `TextDecoder` / `URL` / `structuredClone` but NOT WebCrypto
 * (`expo/src/winter/runtime.native.ts`). So on device `crypto.randomUUID()` is
 * a `TypeError`, not a value.
 *
 * Every client call site knew that and hand-rolled the same
 * `crypto?.randomUUID !== undefined ? … : Math.random()` guard — SIX separate
 * copies across chat-core, the app and the web chat. `SendQueue` was the one
 * that did not, and it sat on the mobile send path: `enqueue()` threw before it
 * could write the optimistic row, the caller swallowed the rejection, and the
 * message vanished with no bubble, no frame and no log. Mobile chat had
 * therefore NEVER delivered a single user message — production evidence: every
 * `client_msg_id` in `app_chat_messages` is a UUID (browser), while the mobile
 * sessions show up only as fallback-form `dev-<base36>` device ids.
 *
 * Six copies of a guard is how one gets missed, so there is now one generator
 * and a test (`__tests__/no-direct-webcrypto.test.ts`) that fails the build if
 * client code reaches for `crypto` directly again.
 *
 * It NEVER throws. Uniqueness, not unpredictability, is what a `client_msg_id`
 * or a device id needs — so a runtime without WebCrypto degrades to
 * `Math.random()` rather than failing. Do NOT use this for anything that must
 * be unguessable.
 */

/** Number of random hex chars in the non-WebCrypto fallback (128-bit-ish). */
const FALLBACK_HEX_CHARS = 32

/**
 * A collision-resistant random id. Prefers `crypto.randomUUID()`, then
 * `crypto.getRandomValues()`, then `Math.random()`. Never throws on a runtime
 * that lacks WebCrypto (i.e. the device).
 */
export function randomId(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* fall through — a runtime may expose the name but refuse the call */
    }
  }
  if (typeof c?.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(FALLBACK_HEX_CHARS / 2)
      c.getRandomValues(bytes)
      return hex(bytes)
    } catch {
      /* fall through */
    }
  }
  let out = ''
  while (out.length < FALLBACK_HEX_CHARS) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0')
  }
  return out.slice(0, FALLBACK_HEX_CHARS)
}

/** A prefixed random id, e.g. `deviceId('dev')` → `dev-…`. */
export function prefixedRandomId(prefix: string): string {
  return `${prefix}-${randomId()}`
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
