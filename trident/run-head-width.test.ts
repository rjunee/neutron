import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewedHeadOid } from './merge.ts'
import { resolveResumeLiveHead } from './orchestrator.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

// Enumerate the production recognizers in this change by their surrounding statement,
// not by the expected pattern: a narrowed or permissive mutation must still be found.
const sites: Record<string, string[]> = {
  'merge.ts': ['const FULL_OID ='],
  'inner-workflow.mjs': ['const FULL_OID =', 'if (/^outer-published:', '? checkpointText.match('],
  'orchestrator.ts': [
    '.test(token)) return token.toLowerCase()',
    '.test(oid)) return oid.toLowerCase()',
    '    /^outer-published:',
    '? resume_checkpoint.match(',
    '.test(recorded) &&',
    '.test(resume_live_head) &&',
    'if (!resolved.ok || !/',
    'if (resolved.ok && /',
    '.test(branchTip))',
    'if (ownCrashLeftover && /',
  ],
  // G084's full-width pin check moved here when the gate was extracted from
  // `publishBuiltCommit`; the recognizer follows the code, not the old file.
  'gates/fix-lineage.ts': ['.test(pin))'],
  // Same rule, same reason: the publication cluster left `orchestrator.ts` (#999)
  // and took its resolved-head recognizer with it. The COUNT is unchanged — 21
  // sites, just one of them in a new file. Lowering the count instead would have
  // been the silent way to lose a recognizer.
  'publication.ts': ['.test(resolvedHead))'],
  'inner-loop.ts': ['.test(input.base_sha)'],
  'checkpoint-round.ts': ['export const OUTER_PUBLISHED_CHECKPOINT ='],
  'run-disposition.ts': ['.test(head)) return null', '.test(trimCheckpoint(run.base_sha)'],
  'store.ts': ['const FULL_OID ='],
}
const EXPECTED_RECOGNIZER_SITES = 21
const GENERATED_TESTS_PER_SITE = 11
const inventory = Object.entries(sites).flatMap(([file, markers]) => {
  const lines = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')
  return markers.map((marker) => {
    const matches = lines.filter((line) => line.includes(marker) && !line.trim().startsWith('//'))
    const literal = matches[0]?.match(/\/(\^.+\$)\/([i]?)/)
    return { file, marker, matches, literal }
  })
})
const selectedSiteCount = inventory.filter(({ literal }) => literal !== null && literal !== undefined).length
const generatedTestCount = inventory.length + (selectedSiteCount * (GENERATED_TESTS_PER_SITE - 1))

test('inventory selects every recognizer site', () => {
  expect(selectedSiteCount).toBe(EXPECTED_RECOGNIZER_SITES)
})

test('inventory generates the complete recognizer test count', () => {
  expect(generatedTestCount).toBe(EXPECTED_RECOGNIZER_SITES * GENERATED_TESTS_PER_SITE)
})

for (const { file, marker, matches, literal } of inventory) {
  describe(`${file}: ${marker}`, () => {
    test('positive control: exactly one executable regex is selected', () => {
      expect(matches).toHaveLength(1)
      expect(matches[0]).toMatch(/\/\^.+\$\/[i]?/)
    })
    if (!literal) return
    const pattern = new RegExp(literal[1]!, literal[2])
    const checkpoint = pattern.source.startsWith('^outer-published:')
    const input = (oid: string): string => checkpoint ? `outer-published:${oid}:2:3:deviated` : oid
    test.each([40, 64])('accepts exactly %i hex digits', (width) => {
      expect(pattern.test(input('a'.repeat(width)))).toBe(true)
    })
    test.each([0, 7, 39, 41, 63, 65])('refuses %i hex digits', (width) => {
      expect(pattern.test(input('a'.repeat(width)))).toBe(false)
    })
    test.each([40, 64])('refuses non-hex at width %i', (width) => {
      expect(pattern.test(input('g'.repeat(width)))).toBe(false)
    })
  })
}

for (const format of ['sha1', 'sha256'] as const) {
  test(`real ${format} heads survive nomination and local/remote resume reads`, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'run-head-width-'))
    const git = (...args: string[]): string => {
      const out = Bun.spawnSync(['git', '-C', repo, ...args])
      expect(out.exitCode).toBe(0)
      return out.stdout.toString().trim()
    }
    try {
      git('init', '--quiet', `--object-format=${format}`, '-b', 'main')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture')
      git('remote', 'add', 'origin', '.')
      const head = git('rev-parse', 'HEAD')
      expect(head.length).toBe(format === 'sha1' ? 40 : 64)
      expect(reviewedHeadOid(makeTridentRun({ inner_result: JSON.stringify({ reviewedHead: head }) }))).toBe(head)
      expect(reviewedHeadOid(makeTridentRun({ inner_result: JSON.stringify({ reviewedHead: head.slice(0, 7) }) }))).toBeNull()
      for (const merge_mode of ['local', 'pr'] as const) {
        expect(await resolveResumeLiveHead(async (cmd) => {
          const out = Bun.spawnSync(cmd)
          return { ok: out.exitCode === 0, stdout: out.stdout.toString(), stderr: out.stderr.toString(), exit_code: out.exitCode }
        }, { repo_path: repo, branch: 'main', merge_mode }, async () => {})).toBe(head)
        expect(await resolveResumeLiveHead(async () => ({ ok: true, stdout: head.slice(0, 7), stderr: '', exit_code: 0 }),
          { repo_path: repo, branch: 'main', merge_mode }, async () => {})).toBe('')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
}
