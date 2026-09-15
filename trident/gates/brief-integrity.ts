/** Compute the byte-count and FNV-1a receipt used for build briefs. */
export function briefIntegrity(text: string): string {
  let bytes = 0
  let h = 0x811c9dc5
  const push = (b: number) => {
    bytes++
    h = Math.imul(h ^ b, 0x01000193) >>> 0
  }
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
        i++
      } else {
        cp = 0xfffd // a high surrogate with nothing after it
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd // a low surrogate with nothing before it
    }
    if (cp < 0x80) {
      push(cp)
    } else if (cp < 0x800) {
      push(0xc0 | (cp >> 6))
      push(0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      push(0xe0 | (cp >> 12))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    } else {
      push(0xf0 | (cp >> 18))
      push(0x80 | ((cp >> 12) & 0x3f))
      push(0x80 | ((cp >> 6) & 0x3f))
      push(0x80 | (cp & 0x3f))
    }
  }
  return `${bytes}:${h.toString(16).padStart(8, '0')}`
}
