import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const source = readFileSync(join(import.meta.dir, 'build-run.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'build-run.test.ts'), 'utf8')
const anchor = "acceptedPlan && strategy === 'task_sequence' && !skipBuild && !recovery"

test('task budget preflight mutations refuse overspend without refusing valid continuation or settlement', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'task-budget-preflight-'))
  const subject = join(directory, 'build-run.ts')
  const tests = join(directory, 'build-run.test.ts')
  const imports = (text: string) => text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g,
    (_match, from, quote, specifier) => `${from}${quote}${specifier === './build-run.ts' ? subject
      : specifier.startsWith('.') ? resolve(import.meta.dir, specifier) : import.meta.resolve(specifier)}${quote}`)
  try {
    expect(source.split(anchor)).toHaveLength(2)
    writeFileSync(tests, imports(suite))
    const run = (text: string) => {
      writeFileSync(subject, imports(text))
      const result = Bun.spawnSync([process.execPath, 'test', tests, '-t', 'task budget preflight'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
    }
    const exhausted = 'task budget preflight refuses an exhausted clean continuation before any worker'
    const allowed = 'task budget preflight permits a clean continuation with remaining budget'
    const settle = 'task budget preflight permits an exhausted intermediate checkpoint to settle without workers'
    const control = run(source)
    expect(control.code, control.output).toBe(0)
    for (const name of [exhausted, allowed, settle]) expect(control.output).toContain(`(pass) ${name}`)
    for (const [find, replacement, failure] of [
      [anchor, 'false', exhausted],
      [anchor, "acceptedPlan && strategy === 'task_sequence' && !recovery", settle],
      ['if (budget) return budget', "return budget ?? blocked('task iteration budget is exhausted')", allowed],
    ]) {
      expect(source.split(find!)).toHaveLength(2)
      const mutant = run(source.replace(find!, replacement!))
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${failure}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
