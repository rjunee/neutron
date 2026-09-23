import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const source = readFileSync(join(import.meta.dir, 'build-run.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'build-run.test.ts'), 'utf8')
const anchor = "strategy === 'task_sequence' && resume.stage === 'built'"
const handoff = 'if (resume.remainingTasks !== 0) resumeTaskHandoff'

function imports(text: string, subject: string): string {
  return text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g, (_match, from, quote, specifier) =>
    `${from}${quote}${specifier === './build-run.ts' ? subject : specifier.startsWith('.')
      ? resolve(import.meta.dir, specifier) : import.meta.resolve(specifier)}${quote}`)
}

test('same-run task-sequence crash guard mutations fail in both directions with a green control', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'task-sequence-crash-'))
  const subject = join(directory, 'build-run.ts')
  const tests = join(directory, 'build-run.test.ts')
  try {
    expect(source.split(anchor)).toHaveLength(2)
    expect(source.split(handoff)).toHaveLength(2)
    writeFileSync(tests, imports(suite, subject))
    const run = (text: string) => {
      writeFileSync(subject, imports(text, subject))
      const result = Bun.spawnSync([process.execPath, 'test', tests, '-t', 'same-run task-sequence'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
    }
    const positive = 'same-run task-sequence terminal checkpoint preserves review without rebuilding'
    const negative = 'same-run task-sequence intermediate checkpoint resumes its handoff without reviewing'
    const contradictory = 'same-run task-sequence checkpoint refuses missing zero-count-agreement'
    const control = run(source)
    expect(control.code, control.output).toBe(0)
    for (const name of [positive, negative, contradictory]) expect(control.output).toContain(`(pass) ${name}`)
    for (const [find, replacement, rejected] of [
      [anchor, 'false', negative],
      [handoff, 'if (true) resumeTaskHandoff', positive],
      [anchor, `${anchor} && resume.remainingTasks !== 0`, contradictory],
    ]) {
      const mutant = run(source.replace(find!, replacement!))
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${rejected}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
