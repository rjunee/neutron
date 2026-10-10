/**
 * The measured test-cost collector (scripts/ci/collect-test-cost-profile.ts).
 *
 * The fixtures are SYNTHETIC logs that copy the line shapes of the retained CI
 * job logs of run 38001520250, and nothing else: GitHub's per-line timestamp
 * prefix and block BOMs, a discovery preamble that lists every header, the
 * pre-runner `bun test --isolate app/__tests__/` step, the runner's SHARD line
 * and every lane marker, Bun's `##[group]<path>:` file headers, the isolation
 * preload's replayed banner + first header, pass/skip/todo/fail case lines with
 * and without durations, the end-of-run summary that repeats skipped cases, the
 * `Ran ... across M files` line and the coverage audit. No real test name, host
 * path or account appears here.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollectError, collectTestCostProfile, main, renderTestCostProfile } from './collect-test-cost-profile.ts'
import { AGGREGATION, COLLECTOR, SCHEMA, serializeTestCostProfile } from '../lib/test-cost-profile.ts'

const HEAD = 'd'.repeat(40)
const BANNER = 'bun test v1.4.2 (744846f84)'
const ISOLATED = 'Process test isolation verified: pid:[4026530001] mnt:[4026530000]'

type FileRun = [path: string, cases: string[]]

/** One Bun process as the isolation preload makes it appear in a CI log. */
function bunRun(files: FileRun[], summary: string[] = []): string[] {
  const out = [BANNER, '', `##[group]${files[0]![0]}:`, BANNER, '']
  files.forEach(([path, cases], i) => {
    out.push(`##[group]${path}:`)
    if (i === 0) out.push(ISOLATED)
    out.push(...cases, '', '##[endgroup]', '')
  })
  const total = files.reduce((n, [, c]) => n + c.length, 0)
  out.push(...summary, '', ` ${total} pass`, ' 0 fail', ` ${total * 2} expect() calls`)
  out.push(`Ran ${total} tests across ${files.length} file${files.length === 1 ? '' : 's'}. [1.23s]`)
  return out
}

function shard1Lines(): string[] {
  return [
    "Current runner version: '2.300.0'",
    '##[group]Run bun install --frozen-lockfile',
    'bun install --frozen-lockfile',
    '##[endgroup]',
    // A discovery preamble printing EVERY file header (both shards). None of it
    // is inside a runner section, so none of it may count.
    ...['alpha/one.test.ts', 'alpha/two.test.ts', 'beta/db.test.ts', 'gamma/http.e2e.test.ts',
      'app/__tests__/device.test.tsx', 'delta/untimed.test.ts', 'delta/fail.spec.ts']
      .flatMap((p) => [`##[group]${p}:`, '##[endgroup]']),
    '##[group]Run bash scripts/run-tests.sh',
    'bash scripts/run-tests.sh',
    '##[endgroup]',
    'run-tests: socket preflight passed (127.0.0.1:40000; listener closed)',
    'run-tests: SHARD 1/2 — executing 2 general + 1 PGLite + 0 device + 1 real-HTTP of 7 discovered',
    '==== chunk 1/1: 2 files (index 0..1) ====',
    ...bunRun(
      [
        ['alpha/one.test.ts', ['(pass) suite > first [1.25ms]', '(skip) suite > skipped', '(pass) suite > fast']],
        ['alpha/two.test.ts', ['(pass) other > slow [1234.50ms]', '(todo) other > later']],
      ],
      ['1 tests skipped:', '(skip) suite > skipped'],
    ),
    '==== PGLite quarantine lane: 1 files (attempt 1/3, max-concurrency=1, timeout=90000ms) ====',
    ...bunRun([['beta/db.test.ts', ['(pass) db > boots [20.00ms]', '(pass) db > reads [0.05ms]']]]),
    '==== real-HTTP isolation lane batch 1/1: 1 files (own process, max-concurrency=1, timeout=15000ms) ====',
    ...bunRun([['gamma/http.e2e.test.ts', ['(pass) http > serves [300.10ms]']]]),
    '---- run-tests coverage audit ----',
    'declared files: 7   bun-discovered: 7   assigned here: 4 (shard 1/2)   files executed: 4 (2 general + 1 PGLite + 0 device + 1 real-HTTP)',
    'run-tests: PASS — all 4/7 files across 3 bounded-memory lane(s) are green.',
    '##[group]Run actions/upload-artifact',
    '##[endgroup]',
  ]
}

function shard2Lines(): string[] {
  return [
    "Current runner version: '2.300.0'",
    // The shard-co-resident app step runs BEFORE the runner and prints headers,
    // including one this shard later executes in its device lane.
    '##[group]Run bun test --isolate app/__tests__/ --max-concurrency=4',
    'bun test --isolate app/__tests__/ --max-concurrency=4',
    '##[endgroup]',
    ...bunRun([['app/__tests__/device.test.tsx', ['(pass) app > renders [3.00ms]']]]),
    '##[group]Run bash scripts/run-tests.sh',
    '##[endgroup]',
    'run-tests: SHARD 2/2 — executing 2 general + 0 PGLite + 1 device + 0 real-HTTP of 7 discovered',
    '==== chunk 1/1: 2 files (index 0..1) ====',
    ...bunRun(
      [
        ['delta/untimed.test.ts', ['(pass) quick > one', '(pass) quick > two']],
        ['delta/fail.spec.ts', ['(fail) broken > case [7.01ms]', '(pass) broken > ok [0.10ms]']],
      ],
      ['1 tests failed:', '(fail) broken > case [7.01ms]'],
    ),
    '==== device-harness isolation lane: 1 files (own process) ====',
    ...bunRun([['app/__tests__/device.test.tsx', ['(pass) app > renders [3.00ms]', '(pass) app > [] edge']]]),
    '---- run-tests coverage audit ----',
    'declared files: 7   bun-discovered: 7   assigned here: 3 (shard 2/2)   files executed: 3 (2 general + 0 PGLite + 1 device + 0 real-HTTP)',
  ]
}

/** Render lines as GitHub stores a job log: BOM, timestamp prefix per line. */
function githubLog(lines: string[]): Uint8Array {
  const body = lines.map((line, i) => {
    const stamp = `2026-01-02T03:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.1234567Z `
    // A stored log block starts with a BOM; one also appears mid-log.
    return `${i === 0 || i === 20 ? '﻿' : ''}${stamp}${line}`
  })
  return new TextEncoder().encode(`${body.join('\n')}\n`)
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function input(l1 = shard1Lines(), l2 = shard2Lines()) {
  return {
    runId: 42,
    headSha: HEAD,
    shardCount: 2,
    jobs: [
      { shard: 1, jobId: 901, log: githubLog(l1) },
      { shard: 2, jobId: 902, log: githubLog(l2) },
    ],
  }
}

const EXPECTED_FILES = [
  { path: './alpha/one.test.ts', lane: 'general', shard: 1, cases: 3, timedCases: 1, costMicros: 1250 },
  { path: './alpha/two.test.ts', lane: 'general', shard: 1, cases: 2, timedCases: 1, costMicros: 1234500 },
  { path: './app/__tests__/device.test.tsx', lane: 'device', shard: 2, cases: 2, timedCases: 1, costMicros: 3000 },
  { path: './beta/db.test.ts', lane: 'pglite', shard: 1, cases: 2, timedCases: 2, costMicros: 20050 },
  { path: './delta/fail.spec.ts', lane: 'general', shard: 2, cases: 2, timedCases: 2, costMicros: 7110 },
  { path: './gamma/http.e2e.test.ts', lane: 'http', shard: 1, cases: 1, timedCases: 1, costMicros: 300100 },
]

describe('collector — positive', () => {
  test('derives the exact canonical profile from real log shapes', () => {
    const inp = input()
    const expected = {
      schema: SCHEMA,
      unit: 'microseconds',
      aggregation: AGGREGATION,
      source: {
        workflow: 'ci',
        runId: 42,
        headSha: HEAD,
        shardCount: 2,
        collector: COLLECTOR,
        jobs: [
          { shard: 1, jobId: 901, logSha256: sha(inp.jobs[0]!.log), measuredFiles: 4, unmeasuredFiles: 0, costMicros: 1250 + 1234500 + 20050 + 300100 },
          { shard: 2, jobId: 902, logSha256: sha(inp.jobs[1]!.log), measuredFiles: 2, unmeasuredFiles: 1, costMicros: 3000 + 7110 },
        ],
      },
      files: EXPECTED_FILES,
      // A file whose cases all ran untimed is UNKNOWN cost, never zero.
      unmeasured: [{ path: './delta/untimed.test.ts', lane: 'general', shard: 2, cases: 2 }],
    }
    const text = renderTestCostProfile(inp)
    expect(text).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    expect(serializeTestCostProfile(collectTestCostProfile(inp))).toBe(text)
  })

  test('the preamble headers are ignored: each file is counted once, in its section lane', () => {
    const profile = collectTestCostProfile(input())
    const all = [...profile.files, ...profile.unmeasured]
    expect(all).toHaveLength(7)
    expect(new Set(all.map((f) => f.path)).size).toBe(7)
    // Executed once, in the device lane, despite the app-step preamble header.
    expect(profile.files.find((f) => f.path === './app/__tests__/device.test.tsx')!.cases).toBe(2)
  })

  test('the summary repeat of a skipped/failed case is not attributed to the last file', () => {
    const profile = collectTestCostProfile(input())
    expect(profile.files.find((f) => f.path === './alpha/two.test.ts')!.cases).toBe(2)
    expect(profile.files.find((f) => f.path === './delta/fail.spec.ts')!.costMicros).toBe(7110)
  })

  test('CR line endings and ANSI escapes are normalized away', () => {
    const l1 = shard1Lines().map((l) => (l.startsWith('(pass) suite > first') ? `\x1b[32m${l}\x1b[0m` : l))
    const bytes = new TextDecoder().decode(githubLog(l1)).replace(/\n/g, '\r\n')
    const inp = input()
    inp.jobs[0]!.log = new TextEncoder().encode(bytes)
    const profile = collectTestCostProfile(inp)
    expect(profile.files.find((f) => f.path === './alpha/one.test.ts')!.costMicros).toBe(1250)
  })
})

describe('collector CLI — --out / --check', () => {
  function withLogs<T>(fn: (dir: string, args: string[]) => T, l1 = shard1Lines(), l2 = shard2Lines()): T {
    const dir = mkdtempSync(join(tmpdir(), 'cost-collector-'))
    try {
      const inp = input(l1, l2)
      writeFileSync(join(dir, 's1.log'), inp.jobs[0]!.log)
      writeFileSync(join(dir, 's2.log'), inp.jobs[1]!.log)
      const args = ['--run-id', '42', '--head-sha', HEAD, '--shard-count', '2',
        '--job', `1=901=${join(dir, 's1.log')}`, '--job', `2=902=${join(dir, 's2.log')}`]
      return fn(dir, args)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const quiet = (sink: string[]) => (line: string) => { sink.push(line) }

  test('--out writes the canonical profile and --check accepts identical logs', () => {
    withLogs((dir, args) => {
      const out = join(dir, 'profile.json')
      const msgs: string[] = []
      expect(main([...args, '--out', out], quiet(msgs))).toBe(0)
      expect(readFileSync(out, 'utf8')).toBe(renderTestCostProfile(input()))
      expect(readdirSync(dir).sort()).toEqual(['profile.json', 's1.log', 's2.log'])
      expect(main([...args, '--check', out], quiet(msgs))).toBe(0)
    })
  })

  test('--check fails on a one-byte change to a log', () => {
    withLogs((dir, args) => {
      const out = join(dir, 'profile.json')
      expect(main([...args, '--out', out], () => {})).toBe(0)
      const log = readFileSync(join(dir, 's2.log'))
      const at = log.indexOf('[3.00ms]')
      expect(at).toBeGreaterThan(0)
      log[at + 1] = '4'.charCodeAt(0)
      writeFileSync(join(dir, 's2.log'), log)
      const msgs: string[] = []
      expect(main([...args, '--check', out], quiet(msgs))).toBe(1)
      expect(msgs.join('\n')).toContain('CHECK FAILED')
    })
  })

  // Each refusal: the collector throws, the CLI exits 1, a fresh --out target is
  // never created, an existing one is left byte-identical, and no temp is left.
  const refusals: Array<[name: string, edit: (l1: string[], l2: string[]) => void, reason: RegExp]> = [
    ['duplicate header across jobs', (_l1, l2) => {
      const i = l2.indexOf('##[group]delta/fail.spec.ts:')
      l2[i] = '##[group]alpha/two.test.ts:'
    }, /shard 2 line \d+: file header duplicates a file already executed on shard 1/],
    ['PGLite retry duplicates the lane', (l1) => {
      const at = l1.indexOf('---- run-tests coverage audit ----')
      l1.splice(at, 0, '==== PGLite quarantine lane: 1 files (attempt 2/3, max-concurrency=1, timeout=90000ms) ====',
        ...bunRun([['beta/db.test.ts', ['(pass) db > boots [20.00ms]', '(pass) db > reads [0.05ms]']]]))
    }, /shard 1 line \d+: file header duplicates a file already executed on shard 1/],
    ['orphan case line', (l1) => {
      const at = l1.indexOf('==== real-HTTP isolation lane batch 1/1: 1 files (own process, max-concurrency=1, timeout=15000ms) ====')
      l1.splice(at + 1, 0, '(pass) stray [1.00ms]')
    }, /shard 1 line \d+: orphan case line before any file header/],
    ['unknown duration unit', (l1) => {
      l1[l1.indexOf('(pass) http > serves [300.10ms]')] = '(pass) http > serves [300.10us]'
    }, /shard 1 line \d+: unknown case duration unit/],
    ['more than 3 fractional digits', (l1) => {
      l1[l1.indexOf('(pass) http > serves [300.10ms]')] = '(pass) http > serves [300.1001ms]'
    }, /shard 1 line \d+: case duration has more than 3 fractional millisecond digits/],
    ['header count disagrees with Bun', (l1) => {
      const i = l1.findIndex((l) => l.startsWith('Ran 1 tests across 1 file.'))
      l1[i] = 'Ran 1 tests across 2 files. [1.23s]'
    }, /shard 1 line \d+: the http section opened at line \d+ has 1 file headers but Bun reported 2 files/],
    ['union disagrees with declared', (_l1, l2) => {
      const i = l2.findIndex((l) => l.startsWith('declared files: 7'))
      l2[i] = l2[i]!.replace('declared files: 7', 'declared files: 8')
    }, /shard 2: declared files 8 != 7 unique files executed across all shards/],
    ['missing declared line', (_l1, l2) => {
      l2.splice(l2.findIndex((l) => l.startsWith('declared files: 7')), 1)
    }, /shard 2: no coverage-audit 'declared files' line/],
    ['shard mismatch', (l1) => {
      const i = l1.findIndex((l) => l.startsWith('run-tests: SHARD 1/2'))
      l1[i] = l1[i]!.replace('SHARD 1/2', 'SHARD 2/2')
    }, /shard 1: log reports SHARD 2\/2, expected 1\/2/],
    ['invalid header path', (_l1, l2) => {
      const i = l2.indexOf('##[group]delta/untimed.test.ts:', l2.indexOf('==== chunk 1/1: 2 files (index 0..1) ===='))
      l2[i] = '##[group]node_modules/pkg/untimed.test.ts:'
    }, /shard 2 line \d+: file header is not a valid discovered test path/],
  ]

  for (const [name, edit, reason] of refusals) {
    test(`refuses: ${name}`, () => {
      const l1 = shard1Lines()
      const l2 = shard2Lines()
      edit(l1, l2)
      let caught: unknown
      try {
        collectTestCostProfile(input(l1, l2))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(CollectError)
      const message = (caught as Error).message
      expect(message).toMatch(reason)
      // A refusal names the shard and line, never the line text.
      expect(message).not.toMatch(/\(pass\)|##\[group\]|suite >|http >/)

      withLogs((dir, args) => {
        const fresh = join(dir, 'fresh.json')
        const msgs: string[] = []
        expect(main([...args, '--out', fresh], quiet(msgs))).toBe(1)
        expect(msgs.join('\n')).toMatch(/REFUSED/)
        expect(existsSync(fresh)).toBe(false)
        const existing = join(dir, 'existing.json')
        writeFileSync(existing, 'previous bytes\n')
        expect(main([...args, '--out', existing], () => {})).toBe(1)
        expect(readFileSync(existing, 'utf8')).toBe('previous bytes\n')
        expect(readdirSync(dir).sort()).toEqual(['existing.json', 's1.log', 's2.log'])
      }, l1, l2)
    })
  }

  test('refuses a second Bun process after case output in one section', () => {
    const l1 = shard1Lines()
    const at = l1.indexOf('==== PGLite quarantine lane: 1 files (attempt 1/3, max-concurrency=1, timeout=90000ms) ====')
    l1.splice(at + 10, 0, BANNER)
    expect(() => collectTestCostProfile(input(l1))).toThrow(/a second Bun process starts after the first produced case output/)
  })

  test('refuses a missing job log or a malformed argument', () => {
    const inp = input()
    inp.jobs.pop()
    expect(() => collectTestCostProfile(inp)).toThrow(/exactly one job log for each shard 1..2/)
    expect(main(['--run-id', 'x'], () => {})).toBe(1)
    expect(main(['--run-id', '1', '--head-sha', HEAD, '--shard-count', '1', '--out', 'a', '--check', 'b'], () => {})).toBe(1)
  })
})
