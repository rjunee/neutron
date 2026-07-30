/**
 * @neutronai/chat-core — CLIENT CODE MAY NOT TOUCH `crypto` DIRECTLY.
 *
 * `crypto` is not a global on the mobile runtime (React Native 0.81 ships no
 * WebCrypto; Expo SDK 54's WinterCG shim installs `TextDecoder`/`URL`/
 * `structuredClone` and stops there). Six client call sites each hand-rolled the
 * same `crypto?.randomUUID !== undefined ? … : fallback` guard, and the seventh
 * — `SendQueue`'s default id generator — did not. That one sat on the mobile
 * send path and silently destroyed every message the owner typed on his phone
 * for the entire life of the surface.
 *
 * A guard that is copy-pasted N times gets missed at N+1. So there is exactly
 * one generator (`chat-core/ids.ts` `randomId`) and this test fails the build if
 * any client module reaches for WebCrypto again.
 *
 * SCOPE — CLIENT ONLY. Server code runs on Bun, where WebCrypto is guaranteed;
 * it is free to use `crypto` directly and is not scanned. The scanned roots are
 * the three trees that ship INTO a browser or onto a device.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Repo root, from `chat-core/__tests__/`. */
const ROOT = join(import.meta.dir, '..', '..')

/** The trees whose code runs on a device or in a browser. */
const CLIENT_ROOTS = ['chat-core', 'app/lib', 'app/app', 'app/components', 'landing/chat-react']

/** The one module allowed to know WebCrypto exists. */
const ALLOWED = [join('chat-core', 'ids.ts')]

/** Any direct member access on the `crypto` global. */
const DIRECT_WEBCRYPTO = /(?<![\w.'"`])crypto\s*\.\s*(randomUUID|getRandomValues|subtle)\b/

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.expo', 'build'])

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('no direct WebCrypto in client code', () => {
  const files = CLIENT_ROOTS.flatMap((root) => walk(join(ROOT, root)))

  it('scans a non-trivial number of client files (the scan itself must not silently find nothing)', () => {
    // A path typo would make every assertion below vacuously pass. Assert the
    // scan has real reach before trusting its verdict.
    expect(files.length).toBeGreaterThan(50)
  })

  it('finds no `crypto.randomUUID` / `getRandomValues` / `subtle` outside chat-core/ids.ts', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1)
      if (ALLOWED.includes(rel)) continue
      const source = readFileSync(file, 'utf8')
      source.split('\n').forEach((line, i) => {
        // A comment that MENTIONS the API is documentation, not a call.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (DIRECT_WEBCRYPTO.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('proves the pattern it looks for actually matches a real call', () => {
    // Mutation-proofing: without this, a regex typo would make the gate above a
    // permanently-green no-op — the exact failure mode of a guard nobody tested.
    expect(DIRECT_WEBCRYPTO.test('const id = crypto.randomUUID()')).toBe(true)
    expect(DIRECT_WEBCRYPTO.test('crypto.getRandomValues(bytes)')).toBe(true)
    expect(DIRECT_WEBCRYPTO.test('await crypto.subtle.digest("SHA-256", buf)')).toBe(true)
    // And does NOT match the safe, guarded indirection the codebase now uses.
    expect(DIRECT_WEBCRYPTO.test('const c = globalThis.crypto; c?.randomUUID?.()')).toBe(false)
    expect(DIRECT_WEBCRYPTO.test('return randomId()')).toBe(false)
  })
})
