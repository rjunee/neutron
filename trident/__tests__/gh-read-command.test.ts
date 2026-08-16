/**
 * THE GITHUB READS CARRY THE INSTANCE CREDENTIAL — at the command-composition
 * layer.
 *
 * `trident/gh-authed.test.ts` proves the token reaches the `gh` child. This file
 * proves the workflow actually COMPOSES that runner: the three probes must not go
 * back to a bare `gh`, and a caller without the new args must get byte-identical
 * legacy behaviour.
 *
 * Tested against the REAL functions extracted from the `.mjs` source (the `grab()`
 * technique the CI-gate tests use): the workflow script cannot be imported (no
 * module resolution; its top-level `return` is the Workflow runtime's result API),
 * and a hand-copied TypeScript duplicate is a test that cannot fail for the reason
 * it claims to check.
 */

import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

/** Brace-match one function out of the source. */
function grab(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

/** Evaluate the real `ghReadCommand` with the module-level args it closes over
 *  bound to the supplied values. */
function loadReal(args: {
  ghAuthedScript: string | null
  ghDataDir: string | null
  ghOwnerHandle: string | null
  dbPath: string | null
  bunBin: string | null
}): (ghArgs: string) => string {
  const bind = (name: keyof typeof args): string => `const ${name} = ${JSON.stringify(args[name])}`
  const factory = new Function(
    `${bind('ghAuthedScript')}\n${bind('ghDataDir')}\n${bind('ghOwnerHandle')}\n${bind('dbPath')}\n${bind('bunBin')}\n` +
      `${grab('shSingleQuote')}\n${grab('ghReadCommand')}\nreturn ghReadCommand`,
  ) as () => (ghArgs: string) => string
  return factory()
}

const THREADED = {
  ghAuthedScript: '/srv/neutron/trident/gh-authed.ts',
  ghDataDir: '/home/owner/projects/acme',
  ghOwnerHandle: 'acme',
  dbPath: '/home/owner/projects/acme/project.db',
  bunBin: '/usr/local/bin/bun',
}

describe('ghReadCommand — the composed GitHub read', () => {
  test('fully threaded → the credentialed runner, invoked through the ABSOLUTE bun binary', () => {
    const cmd = loadReal(THREADED)('pr view 261 --json mergeable,statusCheckRollup')
    // Starts with the quoted bun binary + script — not a bare `gh`, and not a
    // bare `bun` (a subagent's Bash PATH need not have one).
    expect(cmd.startsWith(`'${THREADED.bunBin}' '${THREADED.ghAuthedScript}'`)).toBe(true)
    expect(cmd.startsWith('gh ')).toBe(false)
    // The store coordinates it resolves the token from, and the verbatim tail.
    expect(cmd).toContain(`--db '${THREADED.dbPath}'`)
    expect(cmd).toContain(`--data-dir '${THREADED.ghDataDir}'`)
    expect(cmd).toContain(`--owner '${THREADED.ghOwnerHandle}'`)
    expect(cmd.endsWith('-- pr view 261 --json mergeable,statusCheckRollup')).toBe(true)
  })

  test('the TOKEN is never in the composed command — only paths and a handle', () => {
    const cmd = loadReal(THREADED)('pr checks 261 --json name,state,link')
    expect(cmd).not.toContain('GH_TOKEN')
    expect(cmd).not.toContain('ghp_')
    expect(cmd).not.toContain('auth login')
  })

  test('any coordinate absent → byte-identical bare `gh` (legacy/local mode unchanged)', () => {
    const tail = 'pr view 7 --json state,mergedAt'
    expect(loadReal({ ...THREADED, ghAuthedScript: null })(tail)).toBe(`gh ${tail}`)
    expect(loadReal({ ...THREADED, ghDataDir: null })(tail)).toBe(`gh ${tail}`)
    expect(loadReal({ ...THREADED, ghOwnerHandle: null })(tail)).toBe(`gh ${tail}`)
    expect(loadReal({ ...THREADED, dbPath: null })(tail)).toBe(`gh ${tail}`)
    expect(loadReal({ ...THREADED, bunBin: null })(tail)).toBe(`gh ${tail}`)
    // Empty strings are "absent" too — a threaded-but-blank arg must not compose
    // a command that runs `''`.
    expect(loadReal({ ...THREADED, ghOwnerHandle: '' })(tail)).toBe(`gh ${tail}`)
  })

  test('a path with a quote in it is still single-quoted safely', () => {
    const cmd = loadReal({ ...THREADED, ghDataDir: "/home/o'brien/acme" })('pr view 1')
    expect(cmd).toContain(`--data-dir '/home/o'\\''brien/acme'`)
  })
})

describe('every GitHub READ probe goes through it', () => {
  /** The source of one function, for a literal check. */
  function source(name: string): string {
    return grab(name)
  }

  for (const probe of ['probeCi', 'probeReviewReadiness', 'probeRequiredChecks', 'probePrMerged']) {
    test(`${probe} composes its command with ghReadCommand, not a bare \`gh\``, () => {
      const src = source(probe)
      expect(src).toContain('ghReadCommand(')
      // The regression this pins: a bare `gh pr …` literal back in the command
      // string is exactly the 2026-08-14 defect (an unauthenticated read).
      expect(src).not.toMatch(/&& gh pr /)
    })
  }
})
