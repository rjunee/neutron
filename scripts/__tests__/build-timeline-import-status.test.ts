import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { importStatusWarnings } from '../build-timeline-import-status.ts'

const now = 100_000
const fresh = { lastSuccessAt: now, error: null, partial: false, coverage: { unbound: 0, incomplete: 0, scanPartial: false } }

test('partial flags and each positive coverage counter warn independently; complete coverage stays quiet', () => {
  expect(importStatusWarnings(fresh, now)).toEqual([])
  for (const status of [
    { ...fresh, partial: true },
    { ...fresh, coverage: { ...fresh.coverage, unbound: 7 } },
    { ...fresh, coverage: { ...fresh.coverage, incomplete: 2 } },
    { ...fresh, coverage: { ...fresh.coverage, scanPartial: true } },
  ]) expect(importStatusWarnings(status, now).join(' ')).toContain('coverage is partial')
  const unknown = importStatusWarnings({ lastSuccessAt: now, partial: true }, now).join(' ')
  expect(unknown).toContain('count unknown')
  expect(unknown).not.toContain('0 observations')
  const zero = importStatusWarnings({ ...fresh, partial: true }, now).join(' ')
  expect(zero).toContain('0 observations')
  expect(zero).not.toContain('count unknown')
})

test('malformed coverage and non-current success metadata remain unverified without echoing private data', () => {
  for (const coverage of [null, [], '/private/source', { unbound: -1 }, { unbound: 1.5 },
    { unbound: Number.MAX_SAFE_INTEGER + 1 }, { incomplete: '/private/source' }, { scanPartial: 'yes' }]) {
    const warnings = importStatusWarnings({ ...fresh, coverage }, now).join(' ')
    expect(warnings).toContain('coverage metadata is invalid')
    expect(warnings).not.toContain('/private/source')
  }
  for (const lastSuccessAt of [undefined, -1, now + 1, now - 60_001, Infinity]) {
    expect(importStatusWarnings({ ...fresh, lastSuccessAt }, now).join(' ')).toContain('stale or failed')
  }
  expect(importStatusWarnings({ ...fresh, lastSuccessAt: now - 60_000 }, now)).toEqual([])
  expect(importStatusWarnings({ ...fresh, error: '/private/error' }, now).join(' ')).not.toContain('/private/error')
  for (const status of [null, [], 'invalid']) expect(importStatusWarnings(status, now).join(' ')).toContain('status unavailable')
})

test('both-direction semantic mutants cannot satisfy the coverage contract', () => {
  const source = readFileSync(new URL('../build-timeline-import-status.ts', import.meta.url), 'utf8')
  const marker = "if (status.partial === true || (unbound !== null && unbound > 0) ||\n      (incomplete !== null && incomplete > 0) || coverage.scanPartial === true)"
  expect(source).toContain(marker)
  const satisfies = (read: typeof importStatusWarnings) => {
    const visible = read({ ...fresh, partial: true, coverage: { ...fresh.coverage, unbound: 7 } }, now).join(' ')
    return visible.includes('7 observations have no verified PR/phase binding') && read(fresh, now).length === 0
  }
  expect(satisfies(importStatusWarnings)).toBe(true)
  for (const replacement of ['if (false)', 'if (true)']) {
    const changed = source.replace(marker, replacement).replace('export function', 'function')
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(changed)
    const mutant = new Function(js + '\nreturn importStatusWarnings')() as typeof importStatusWarnings
    expect(satisfies(mutant)).toBe(false)
  }
})
