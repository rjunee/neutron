import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { passedCase } from './mutation-test-report.ts'

const root = resolve(import.meta.dir, '..')
const driver = readFileSync(join(import.meta.dir, 'build-run.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'build-run.test.ts'), 'utf8')

test('legacy terminal checkpoint mutations preserve terminal adoption and intermediate refusal', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'legacy-terminal-'))
  const driverPath = join(directory, 'build-run.ts')
  const testPath = join(directory, 'build-run.test.ts')
  const report = join(directory, 'report.xml')
  const imports = (text: string) => text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g,
    (_match, from, quote, name) => `${from}${quote}${name === './build-run.ts' ? driverPath
      : name.startsWith('.') ? resolve(import.meta.dir, name) : import.meta.resolve(name)}${quote}`)
  const replace = (before: string, after: string) => {
    expect(driver.split(before)).toHaveLength(2)
    return driver.replace(before, after)
  }
  try {
    writeFileSync(testPath, imports(suite))
    const run = (source: string) => {
      writeFileSync(driverPath, imports(source))
      const result = Bun.spawnSync([process.execPath, 'test', testPath, '-t',
        'migrated terminal task-sequence checkpoint|same-run task-sequence checkpoint refuses',
        '--reporter=junit', `--reporter-outfile=${report}`], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), report: readFileSync(report, 'utf8') }
    }
    const positive = 'migrated terminal task-sequence checkpoint resumes fresh review without an invented plan'
    const control = run(driver)
    expect(control.code, control.output).toBe(0)
    expect(passedCase(control.report, positive), control.report).toBe(true)
    for (const [source, killed, sibling] of [
      [replace("const legacyTerminal = selected?.source === 'legacy'", 'const legacyTerminal = false'), positive,
        'same-run task-sequence checkpoint refuses missing plan'],
      [replace('&& resume.remainingTasks === 0', '&& resume.remainingTasks! >= 0'),
        'same-run task-sequence checkpoint refuses missing plan', positive],
      [replace("selected?.source === 'legacy' && acceptedPlan === null", "selected?.source === 'legacy'"),
        'same-run task-sequence checkpoint refuses missing legacy-zero-count-agreement', positive],
    ]) {
      const mutant = run(source!)
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${killed}`)
      expect(mutant.output).toContain(`(pass) ${sibling}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 120_000)
