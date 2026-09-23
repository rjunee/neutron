import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { passedCase } from './mutation-test-report.ts'

const root = resolve(import.meta.dir, '..')
const host = readFileSync(join(import.meta.dir, 'production-host-effects.ts'), 'utf8')
const store = readFileSync(join(import.meta.dir, 'store.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'production-host-effects.test.ts'), 'utf8')

test('task ledger intent mutations preserve both adoption and refusal controls', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'ledger-intent-'))
  const hostPath = join(directory, 'production-host-effects.ts')
  const storePath = join(directory, 'store.ts')
  const testPath = join(directory, 'production-host-effects.test.ts')
  const report = join(directory, 'report.xml')
  const imports = (text: string) => text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g,
    (_match, from, quote, name) => `${from}${quote}${name === './production-host-effects.ts' ? hostPath
      : name === './store.ts' ? storePath : name.startsWith('.') ? resolve(import.meta.dir, name) : import.meta.resolve(name)}${quote}`)
  const replace = (source: string, before: string, after: string) => {
    expect(source.split(before)).toHaveLength(2)
    return source.replace(before, after)
  }
  try {
    writeFileSync(testPath, imports(suite))
    const run = (hostSource: string, storeSource: string) => {
      writeFileSync(hostPath, imports(hostSource))
      writeFileSync(storePath, imports(storeSource))
      const result = Bun.spawnSync([process.execPath, 'test', testPath, '-t', 'task ledger intent', '--reporter=junit', `--reporter-outfile=${report}`], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), report: readFileSync(report, 'utf8') }
    }
    const control = run(host, store)
    expect(control.code, control.output).toBe(0)
    const positive = 'task ledger intent authenticates the real child and charges repeated recovery only once'
    expect(passedCase(control.report, positive), control.report).toBe(true)
    for (const [hostSource, storeSource, killed] of [
      [replace(host, 'if (parents.stdout.trim() !== `${snapshot.head} ${intent.builtHead}`)', 'if (false)'),
        store, 'task ledger intent refuses merge without refunding completed work'],
      [replace(host, 'if (changed.stdout !== `${ledgerFile}\\0`)', 'if (false)'),
        store, 'task ledger intent refuses extra-file without refunding completed work'],
      [replace(host, 'if (entry.stdout !== `100644 blob ${expected}\\t${ledgerFile}\\0`)', 'if (true)'), store, positive],
      [host, replace(store,
        'Math.max(state.iteration, state.checkpoint.handoff ? state.checkpoint.handoff.iteration + 1 : 0)',
        'state.iteration'), positive],
      [replace(host,
        'if (state.checkpoint.handoff && !store.taskHandoffSpendMatches(runId, state.checkpoint.handoff.iteration))',
        'if (false)'), store, 'task ledger intent cannot reuse an old identity after run spend advances'],
    ]) {
      const mutant = run(hostSource!, storeSource!)
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${killed}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 180_000)
