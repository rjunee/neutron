import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const source = readFileSync(join(import.meta.dir, 'orchestrator.ts'), 'utf8')
const suite = readFileSync(join(import.meta.dir, 'orchestrator.test.ts'), 'utf8')
const anchor = 'if (!continuationReady) {'

// Copy only the subject and its semantic tests. All other imports resolve to the
// real modules, so neither the working tree nor another test process is mutated.
function imports(text: string, subject: string): string {
  return text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g, (_match, from, quote, specifier) =>
    `${from}${quote}${specifier === './orchestrator.ts' ? subject : specifier.startsWith('.')
      ? resolve(import.meta.dir, specifier) : import.meta.resolve(specifier)}${quote}`)
}

test('project-driver recovery guard mutations fail in both directions, with a green control', () => {
  const parent = join(root, '.trident-mutants')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'project-driver-recovery-'))
  const subject = join(directory, 'orchestrator.ts')
  const tests = join(directory, 'orchestrator.test.ts')
  try {
    expect(source.split(anchor)).toHaveLength(2)
    writeFileSync(tests, imports(suite, subject))
    const run = (text: string) => {
      writeFileSync(subject, imports(text, subject))
      const result = Bun.spawnSync([process.execPath, 'test', tests, '-t', 'project-driver gateway recovery'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
    }
    const control = run(source)
    expect(control.code, control.output).toBe(0)
    expect(control.output).toContain('(pass) project-driver gateway recovery > a prior gateway reservation resumes only from the durable branch/head/checkpoint')
    expect(control.output).toContain('(pass) project-driver gateway recovery > an uncheckpointed prior-gateway reservation becomes terminal instead of replaying')
    for (const [replacement, rejectedTest] of [
      ['if (true) {', 'a prior gateway reservation resumes only from the durable branch/head/checkpoint'],
      ['if (false) {', 'an uncheckpointed prior-gateway reservation becomes terminal instead of replaying'],
    ]) {
      const mutant = run(source.replace(anchor, replacement!))
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) project-driver gateway recovery > ${rejectedTest}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
