import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { passedCase } from './mutation-test-report.ts'

const root = resolve(import.meta.dir, '..')
const source = readFileSync(join(import.meta.dir, 'project-review-source.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'project-review-source.test.ts'), 'utf8')
const repairCase = 'verdict repair carries the exact host path once and preserves a repaired rejection across restart'
const exhaustedCase = 'verdict repair exhaustion blocks without synthesis or a third purchase after restart'
const pendingCase = 'verdict repair does not reinterpret uncertain pending recovery as a fresh attempt'
const siblingCase = 'durable completed rejection and rate limit cannot purchase another review on recovery'

function imports(text: string, subject: string): string {
  return text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g, (_match, from, quote, specifier) =>
    `${from}${quote}${specifier === './project-review-source.ts' ? subject : specifier.startsWith('.')
      ? resolve(import.meta.dir, specifier) : import.meta.resolve(specifier)}${quote}`)
}

test('verdict repair semantic mutants fail closed and fail open with a passing control', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'review-repair-'))
  const subject = join(directory, 'project-review-source.ts')
  const tests = join(directory, 'project-review-source.test.ts')
  const report = join(directory, 'report.xml')
  try {
    const rewritten = imports(suite, subject)
    expect(rewritten).toContain(`from '${subject}'`)
    expect(rewritten).not.toContain("from './project-review-source.ts'")
    writeFileSync(tests, rewritten)
    const run = (text: string, filter = 'verdict repair') => {
      writeFileSync(subject, imports(text, subject))
      const result = Bun.spawnSync([process.execPath, 'test', tests, '-t', filter, '--reporter=junit', `--reporter-outfile=${report}`], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), report: readFileSync(report, 'utf8') }
    }
    const control = run(source)
    expect(control.code, control.output).toBe(0)
    for (const name of [repairCase, exhaustedCase, pendingCase]) expect(passedCase(control.report, name), control.report).toBe(true)
    for (const [anchor, replacement, killedBy] of [
      ["request.role === 'review' && outcome.kind === 'unknown'", "false && outcome.kind === 'unknown'", repairCase],
      ["if (!checked.ok) return { ...identity, status: 'deferred'", "if (!checked.ok) return { ...identity, status: 'completed'", exhaustedCase],
      ["if (recovering && outcome.kind !== 'completed')", "if (false && outcome.kind !== 'completed')", pendingCase],
      ["operation = { ...operation, repair: payload.repair }", "operation = { ...operation }", repairCase],
    ]) {
      expect(source.split(anchor!)).toHaveLength(2)
      const mutant = run(source.replace(anchor!, replacement!))
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${killedBy}`)
      const sibling = run(source.replace(anchor!, replacement!), siblingCase)
      expect(sibling.code, sibling.output).toBe(0)
      expect(passedCase(sibling.report, siblingCase), sibling.report).toBe(true)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 60_000)
