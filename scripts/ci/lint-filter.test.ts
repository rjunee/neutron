import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { formatGatedMessages } from './lint-filter.mjs'

const fixtureDir = join(import.meta.dir, '../../trident/.lint-filter-fixture')
const repoRoot = join(import.meta.dir, '../..')
const eslintCli = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js')

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

describe('cross-workspace lint diagnostic', () => {
  test('replaces the root meta-package suggestion with resolvable alternatives', () => {
    const result = formatGatedMessages([
      {
        filePath: 'trident/example.test.ts',
        messages: [
          {
            ruleId: 'import/no-relative-packages',
            line: 1,
            column: 20,
            message:
              'Relative import from another package is not allowed. Use `neutron/tests/support/helper.ts` instead of `../tests/support/helper.ts`',
          },
        ],
      },
    ])

    expect(result.count).toBe(1)
    expect(result.lines[0]).toContain('Root support code has no package specifier.')
    expect(result.lines[0]).toContain('workspace-local relative import')
    expect(result.lines[0]).toContain('@neutronai/<workspace>/<path>')
    expect(result.lines[0]).not.toContain('Use `neutron/')
  })

  test('the underlying rule catches a cross-workspace import and accepts a local import', async () => {
    await mkdir(fixtureDir, { recursive: true })
    const localPath = join(fixtureDir, 'local.ts')
    const importerPath = join(fixtureDir, 'importer.ts')
    await writeFile(localPath, 'export const local = true\n')

    await writeFile(importerPath, "import { createLogger } from '../../logger/index.ts'\nvoid createLogger\n")
    const crossWorkspace = Bun.spawnSync(
      [process.execPath, eslintCli, importerPath, '--format', 'json'],
      { cwd: repoRoot },
    )
    const crossReport = JSON.parse(crossWorkspace.stdout.toString())
    expect(crossReport[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'import/no-relative-packages' }),
      ]),
    )

    await writeFile(importerPath, "import { local } from './local.ts'\nvoid local\n")
    const local = Bun.spawnSync([process.execPath, eslintCli, importerPath, '--format', 'json'], {
      cwd: repoRoot,
    })
    const localReport = JSON.parse(local.stdout.toString())
    expect(localReport[0].messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'import/no-relative-packages' }),
      ]),
    )
  })
})
