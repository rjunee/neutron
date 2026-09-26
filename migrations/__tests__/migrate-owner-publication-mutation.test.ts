import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const migrations = join(import.meta.dir, '..')
const repo = join(migrations, '..')
const consumer = join(repo, 'gateway/nexus/__tests__/init-contention.test.ts')

test('Nexus ownership publication rejects partial publication and both ownership guard mutations', async () => {
  const original = readFileSync(join(migrations, 'runner.ts'), 'utf8')
  const cases = [
    { name: 'control', source: original, green: true },
    { name: 'public-before-complete', source: original.replace('          stagedMarker,', '          markerPath,'), green: false },
    { name: 'ignore-winning-owner', source: original.replace('      marker = readMarker()', '      marker = null'), green: false },
    { name: 'admit-foreign-owner', source: original.replace('return canonicalOwnerPath(recorded) !== canonicalOwnerPath(here)', 'return false'), green: false },
    { name: 'refuse-own-owner', source: original.replace('return canonicalOwnerPath(recorded) !== canonicalOwnerPath(here)', 'return true'), green: false },
  ]
  const root = mkdtempSync(join(migrations, '.owner-publication-mutants-'))
  try {
    for (const variant of cases) {
      if (!variant.green) expect(variant.source).not.toBe(original)
      const dir = join(root, variant.name)
      mkdirSync(dir)
      for (const file of ['db-path.ts', 'provenance.ts', 'git-index.ts']) cpSync(join(migrations, file), join(dir, file))
      const runner = join(dir, 'runner.ts')
      writeFileSync(runner, variant.source)
      const child = Bun.spawn([process.execPath, 'test', consumer, '-t', 'migration ownership publication'], {
        cwd: repo, env: { ...process.env, OWNER_PUBLICATION_RUNNER: runner }, stdout: 'pipe', stderr: 'pipe',
      })
      const deadline = setTimeout(() => child.kill(), 20_000)
      try {
        const [exit, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ])
        const output = `${stdout}\n${stderr}`
        if (variant.green) expect(exit, output).toBe(0)
        else {
          expect(exit, `${variant.name}: ${output}`).not.toBe(0)
          expect(output).toContain('error: expect(received)')
          expect(output).toContain('(fail) migration ownership publication')
        }
      } finally {
        clearTimeout(deadline)
        child.kill()
        await child.exited
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
