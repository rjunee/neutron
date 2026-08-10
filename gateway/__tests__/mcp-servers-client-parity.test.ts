/**
 * WEB AND MOBILE MUST AGREE ABOUT WHICH PROGRAMS THE ASSISTANT MAY START.
 *
 * `splitCommandLine` and `serverSummary` exist twice — `app/lib/mcp-servers-client.ts`
 * and `landing/chat-react/mcp-servers-client.ts` — because each client bundle is
 * deliberately free of the other's workspace. That duplication is correct, and it is
 * also the risk: **these two functions encode product decisions, not transport.**
 *
 * A divergence is the failure nobody reports. Each surface stays self-consistent, so
 * neither looks broken; the owner simply gets a different answer depending on which
 * device he opened. And here that is worse than a cosmetic mismatch:
 *
 *   - `splitCommandLine` decides WHAT ARGV a server is installed with. If the two
 *     copies disagree about a quoted segment, then installing the same pasted line
 *     from the phone and from the browser produces two DIFFERENT programs — and each
 *     one's approval prompt would honestly describe the different thing it built.
 *   - `serverSummary().needs_owner` decides where the "act on this" affordance
 *     appears. A copy that dropped `denied` would hide the row the owner has to
 *     revisit, on one platform only.
 *
 * SO THE COPIES ARE EXECUTED SIDE BY SIDE over the same inputs.
 *
 * WHY THIS FILE LIVES IN `gateway/__tests__`. `landing` does not declare
 * `@neutronai/app` as a dependency and must not start — that independence is the whole
 * reason the helpers are duplicated. `gateway` is the one package that declares BOTH,
 * the same home and reasoning as `phase-models-client-parity.test.ts` beside it.
 */

import { describe, expect, test } from 'bun:test'

import * as mobile from '@neutronai/app/lib/mcp-servers-client'
import * as web from '@neutronai/landing/chat-react/mcp-servers-client.ts'

/**
 * Every shape a pasted command line can take, including the ones with no obviously
 * right answer. A case list is the point: a single happy-path comparison would agree
 * on both copies of a rule that is wrong in the same way.
 */
const LINES: string[] = [
  '/usr/local/bin/example-mcp',
  '/usr/local/bin/example-mcp --stdio',
  '/usr/local/bin/example-mcp --stdio --region eu',
  '  /usr/local/bin/example-mcp   --stdio  ',
  'example-mcp --flag "two words"',
  "example-mcp --flag 'two words'",
  'example-mcp --json {"a":1}',
  'example-mcp --path "/a b/c" --other',
  'example-mcp --empty ""',
  'example-mcp --unterminated "still open',
  'example-mcp\t--tabbed\targ',
  'npx -y @scope/example-mcp@1.2.3',
  '',
  '   ',
  '"/path with spaces/example-mcp" --stdio',
  "example-mcp --it's-quoted",
]

const ROWS: web.McpServerRow[] = (
  [
    ['approved', true],
    ['approved', false],
    ['pending', true],
    ['pending', false],
    ['denied', true],
    ['unapproved', true],
    ['unapproved', false],
  ] as Array<[web.McpApprovalState, boolean]>
).map(([approval, secrets_present]) => ({
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio'],
  env_names: ['EXAMPLE_API_KEY'],
  approval,
  grant_prompt: 'rendered by the server',
  secrets_present,
  active: approval === 'approved' && secrets_present,
}))

describe('splitCommandLine — the phone and the browser build the same argv', () => {
  for (const line of LINES) {
    test(JSON.stringify(line), () => {
      expect(web.splitCommandLine(line)).toEqual(
        mobile.splitCommandLine(line) as ReturnType<typeof web.splitCommandLine>,
      )
    })
  }

  test('a quoted segment stays ONE arg — the decision worth pinning', () => {
    // Splitting it would silently change what runs, and the approval prompt would
    // then accurately describe the wrong command.
    const parsed = web.splitCommandLine('example-mcp --flag "two words"')
    expect(parsed.command).toBe('example-mcp')
    expect(parsed.args).toEqual(['--flag', 'two words'])
  })

  test('an unterminated quote keeps the rest of the line rather than dropping it', () => {
    // Discarding characters the owner typed would produce a command he never wrote.
    expect(web.splitCommandLine('example-mcp "still open').args).toEqual(['still open'])
  })
})

describe('serverSummary — the phone and the browser show the same row', () => {
  for (const row of ROWS) {
    test(`${row.approval}/secrets=${row.secrets_present}`, () => {
      expect(web.serverSummary(row)).toEqual(
        mobile.serverSummary(row as unknown as mobile.McpServerRow) as ReturnType<
          typeof web.serverSummary
        >,
      )
    })
  }

  test('pending and denied both need the owner; unapproved does not', () => {
    // `unapproved` is where a row lands when its command was edited after approval —
    // the server has already re-asked, so the PENDING row is what he acts on.
    const at = (approval: web.McpApprovalState): boolean =>
      web.serverSummary({ ...ROWS[0]!, approval, secrets_present: true }).needs_owner
    expect(at('pending')).toBe(true)
    expect(at('denied')).toBe(true)
    expect(at('unapproved')).toBe(false)
    expect(at('approved')).toBe(false)
  })

  test('an approved server with a MISSING secret is not reported as running', () => {
    // "Approved" and "actually starting" are different facts, and the difference is
    // invisible from chat.
    const label = web.serverSummary({ ...ROWS[0]!, approval: 'approved', secrets_present: false }).label
    expect(label).toContain('missing')
    expect(web.serverSummary({ ...ROWS[0]!, approval: 'approved', secrets_present: true }).label).toContain(
      'running',
    )
  })
})

describe('the agreement is real, not vacuous', () => {
  test('the helpers actually do something — a positive control', () => {
    // WITHOUT THIS, two functions that both returned their input unchanged would pass
    // every comparison above. The suite must be able to fail.
    expect(web.splitCommandLine('a b c')).toEqual({ command: 'a', args: ['b', 'c'] })
    expect(web.serverSummary({ ...ROWS[0]!, approval: 'pending' }).needs_owner).toBe(true)
  })

  test('both copies are the SAME shape of function, not one wrapping the other', () => {
    expect(web.splitCommandLine.length).toBe(mobile.splitCommandLine.length)
    expect(web.serverSummary.length).toBe(mobile.serverSummary.length)
  })
})
