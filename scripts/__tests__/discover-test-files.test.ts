import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DISCOVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'discover-test-files.sh')
const SUFFIXES = [
  '.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.test.mjs', '.test.cjs',
  '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx', '.spec.mjs', '.spec.cjs',
]

describe('test-file discovery', () => {
  test('keeps all twelve patterns, root files, and nested files while excluding dependency and dot directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-discovery-'))
    try {
      const add = (path: string) => {
        const target = join(root, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, '')
      }

      for (const [i, suffix] of SUFFIXES.entries()) {
        add(`root-${i}${suffix}`)
        add(`pkg/nested-${i}${suffix}`)
        add(`node_modules/root-${i}${suffix}`)
        add(`pkg/node_modules/nested-${i}${suffix}`)
        add(`.hidden/root-${i}${suffix}`)
        add(`pkg/.hidden/nested-${i}${suffix}`)
      }
      add('.visible.test.ts') // A dot-file is not a dot-directory.
      add('pkg/.visible.spec.ts')
      add('pkg/node_modules.test.ts') // A file named like a directory is included.
      add('pkg/ordinary.ts')

      const env = { ...process.env }
      delete env.NEUTRON_TEST_DISCOVER_OVERRIDE
      const result = spawnSync('bash', ['-c', '. "$1"; neutron_discover_test_files', '_', DISCOVER], {
        cwd: root,
        env,
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const expected = [
        './.visible.test.ts',
        './pkg/.visible.spec.ts',
        './pkg/node_modules.test.ts',
        ...SUFFIXES.flatMap((suffix, i) => [`./root-${i}${suffix}`, `./pkg/nested-${i}${suffix}`]),
      ].sort()
      expect(result.stdout.trimEnd().split('\n')).toEqual(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
