/**
 * THE COMPOSER GRAPH MUST NOT CONTAIN THE GATEWAY ENTRY MODULE.
 *
 * `gateway/composer-contract.ts` states the boundary in prose: "the composer
 * graph must NOT contain the entry module (`gateway/index.ts`) at all —
 * importing helpers back from the entry created a top-level-await
 * entry↔composer cycle that completes under Bun's current loader but can
 * deadlock under a strict reading of the ESM TLA spec, and prod bun is
 * PATH-pinned, not version-pinned."
 *
 * NOTHING MECHANICAL ENFORCED THAT SENTENCE. The depcruise rule that looks
 * closest — `nobody-imports-composition` — explicitly exempts `^open` ("the one
 * mutual exception, both being composition"), so `open/* → gateway/index.ts` is
 * green by construction and the no-cycles rule only fires once a cycle actually
 * COMPLETES. A one-way edge into the entry is invisible to both, and that is
 * exactly the state a review found this branch in:
 * `open/owner-identity.ts` imported the canonical slug resolver from
 * `@neutronai/gateway/index.ts`, and `open/composer.ts` imports
 * `open/owner-identity.ts`. The fix moved the resolver into the `config` leaf;
 * this test is what stops it coming back.
 *
 * STATIC EDGES ONLY, deliberately. `gateway/index.ts` reaches a composer
 * through `loadGraphComposerFromEnv`'s DYNAMIC import precisely so the static
 * graph stays acyclic — a dynamic edge is the sanctioned direction and counting
 * it would make this test forbid the design it exists to protect.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const COMPOSER_ENTRY = join(REPO_ROOT, 'open/composer.ts')
const GATEWAY_ENTRY = join(REPO_ROOT, 'gateway/index.ts')

/**
 * Strip comments before scanning. A `from '…'` inside a docblock is prose, and
 * this file's whole job is to distinguish a real edge from a mention of one —
 * several modules here document the very import they are forbidden to make.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Static `import … from '…'` / `export … from '…'` / bare `import '…'`. */
function staticSpecifiers(src: string): string[] {
  const clean = stripComments(src)
  const out: string[] = []
  for (const m of clean.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1] as string)
  for (const m of clean.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1] as string)
  return out
}

/**
 * Walk the STATIC import graph from `entry`, returning every in-repo file
 * reached. Resolution goes through `Bun.resolveSync` — the real resolver, not a
 * hand-rolled guess at how `@neutronai/*` workspace specifiers map to
 * directories. A specifier that lands outside the repo (an npm dependency) or
 * fails to resolve (a type-only package, a platform module) is simply not an
 * in-repo edge and is skipped.
 */
function reachableFiles(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of staticSpecifiers(src)) {
      if (spec.startsWith('node:') || spec.startsWith('bun:')) continue
      let resolved: string
      try {
        resolved = Bun.resolveSync(spec, dirname(file))
      } catch {
        continue
      }
      if (!resolved.startsWith(REPO_ROOT)) continue
      if (resolved.includes('/node_modules/')) continue
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

describe('the Open composer graph and the gateway entry module', () => {
  const graph = reachableFiles(COMPOSER_ENTRY)

  it('the walker is alive and can see a POSITIVE', () => {
    // Rule 7: before believing this walker's negative, make it prove it can
    // return a positive on the same kind of input. A walker that resolved
    // nothing — a broken `@neutronai/*` alias, a regex that matched no
    // specifier — would report an empty graph and pass the real assertion
    // below vacuously, which is the dead-gate failure this repo has paid for
    // twice already.
    expect(graph.size).toBeGreaterThan(50)
    expect(graph.has(COMPOSER_ENTRY)).toBe(true)
    // Reached through the `@neutronai/*` workspace form specifically, so an
    // alias that stopped resolving cannot masquerade as a clean graph.
    expect(graph.has(join(REPO_ROOT, 'open/owner-identity.ts'))).toBe(true)
    expect(graph.has(join(REPO_ROOT, 'gateway/composer-contract.ts'))).toBe(true)
  })

  it('the walker DOES report the forbidden edge when one exists (control)', () => {
    // The same walker, seeded at a file that really does import
    // `@neutronai/gateway/index.ts` — this test file's sibling. If the negative
    // below were caused by the walker being unable to see the entry module at
    // all, this goes red and says so.
    const control = reachableFiles(join(REPO_ROOT, 'open/__tests__/owner-slug-agreement.test.ts'))
    expect(control.has(GATEWAY_ENTRY)).toBe(true)
  })

  it('does NOT reach gateway/index.ts', () => {
    // Report the FIRST importer, not just a boolean: "the graph contains the
    // entry" is not actionable, and the previous occurrence took a reviewer
    // reading three files to attribute.
    const offenders = [...graph]
      .filter((f) => f !== GATEWAY_ENTRY)
      .filter((f) => {
        let src: string
        try {
          src = stripComments(readFileSync(f, 'utf8'))
        } catch {
          return false
        }
        return staticSpecifiers(src).some((spec) => {
          if (spec.startsWith('node:') || spec.startsWith('bun:')) return false
          try {
            return Bun.resolveSync(spec, dirname(f)) === GATEWAY_ENTRY
          } catch {
            return false
          }
        })
      })
      .map((f) => f.slice(REPO_ROOT.length))
      .sort()

    const report =
      offenders.length === 0
        ? ''
        : [
            'These modules are in the Open composer graph and statically import',
            'gateway/index.ts, which gateway/composer-contract.ts forbids:',
            ...offenders.map((f) => `  • ${f}`),
            '',
            'Import the helper from the leaf that owns it (config/, or a boot-*',
            'cluster module re-exported through gateway/composer-contract.ts).',
            'depcruise permits open → gateway wholesale, so no other gate sees',
            'this; the entry↔composer TLA cycle is the reason the rule exists.',
          ].join('\n')
    expect(report).toBe('')
    expect(graph.has(GATEWAY_ENTRY)).toBe(false)
  })
})
