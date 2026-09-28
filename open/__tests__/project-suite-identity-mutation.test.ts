import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const modulePath = new URL('../wiring/project-build-dependencies.ts', import.meta.url).pathname
const helperPath = new URL('../wiring/project-build-installed-tree.py', import.meta.url).pathname
const identityTests = new URL('./project-suite-identity.test.ts', import.meta.url).pathname
const probeTests = new URL('./project-installed-tree-probe.test.ts', import.meta.url).pathname
const root = new URL('../../', import.meta.url).pathname
function imports(text: string, importer: string, subject?: string): string {
  return text.replace(/(from\s+)(['"])((?:\.\.?\/|@neutronai\/)[^'"]+)\2/g,
    (_match, from, quote, name) => `${from}${quote}${name.endsWith('/project-build-dependencies.ts') && subject
      ? subject : name.startsWith('.') ? resolve(dirname(importer), name) : Bun.resolveSync(name, importer)}${quote}`)
}

test('installed identity deadline mutations reject both false unavailability and unbounded acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-deadline-mutants-'))
  const subject = join(directory, 'dependencies.ts'), suite = join(directory, 'identity.test.ts')
  try {
    const prepared = imports(await readFile(modulePath, 'utf8'), modulePath)
      .replace("const hostDirectory = fileURLToPath(new URL('../../', import.meta.url))", `const hostDirectory = ${JSON.stringify(root)}`)
      .replace("const hostInstalledTreeProbe = fileURLToPath(new URL('./project-build-installed-tree.py', import.meta.url))", `const hostInstalledTreeProbe = ${JSON.stringify(helperPath)}`)
    await writeFile(suite, imports(await readFile(identityTests, 'utf8'), identityTests, subject))
    const run = async () => {
      const child = Bun.spawn([process.execPath, 'test', suite, '-t', 'installed identity deadline'],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code, output: stdout + stderr }
      } finally { clearTimeout(timer) }
    }
    await writeFile(subject, prepared)
    const control = await run()
    expect(control.code, control.output).toBe(0)
    expect(control.output).toContain('3 pass')
    for (const [find, replacement, failed] of [
      ['export const PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS = 30_000', 'export const PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS = 5000', 'admits a complete slow walk'],
      ["  if (performance.now() >= deadline) return refuse('deadline')\n  if (portable", "  if (portable", 'refuses complete output'],
      ['installedEntries(root, batch, deadline, run)', 'installedEntries(root, batch, performance.now() + PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS, run)', 'carries the remaining budget'],
    ]) {
      expect(prepared.split(find!)).toHaveLength(2)
      await writeFile(subject, prepared.replace(find!, replacement!))
      const mutant = await run()
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) installed identity deadline ${failed}`)
      expect(mutant.output).toContain('error: expect(received)')
      expect(mutant.output).not.toContain('SyntaxError')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 45_000)

test('byte identity mutations preserve hardlink siblings and catch changed bytes and unsafe reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'byte-identity-mutants-'))
  const subject = join(directory, 'dependencies.ts'), helper = join(directory, 'probe.py')
  const suite = join(directory, 'identity.test.ts'), probes = join(directory, 'probe.test.ts')
  try {
    const source = await readFile(modulePath, 'utf8'), native = await readFile(helperPath, 'utf8')
    const prepared = imports(source, modulePath)
      .replace("const hostDirectory = fileURLToPath(new URL('../../', import.meta.url))", `const hostDirectory = ${JSON.stringify(root)}`)
      .replace("const hostInstalledTreeProbe = fileURLToPath(new URL('./project-build-installed-tree.py', import.meta.url))", `const hostInstalledTreeProbe = ${JSON.stringify(helperPath)}`)
    await writeFile(subject, prepared)
    await writeFile(suite, imports(await readFile(identityTests, 'utf8'), identityTests, subject))
    await writeFile(probes, imports(await readFile(probeTests, 'utf8'), probeTests)
      .replace("const helper = new URL('../wiring/project-build-installed-tree.py', import.meta.url).pathname", `const helper = ${JSON.stringify(helper)}`))
    const run = async (file: string, filter: string) => {
      const child = Bun.spawn([process.execPath, 'test', file, '-t', filter], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => child.kill(), 30_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { code, output: stdout + stderr }
      } finally { clearTimeout(timer) }
    }
    const shared = 'shared dependency'
    const control = await run(suite, shared)
    expect(control.code, control.output).toBe(0)
    expect(control.output).toContain('2 pass')
    const anchor = "      fields[index + 6] = '0'"
    expect(prepared.split(anchor)).toHaveLength(3) // regular files and workspace directories
    for (const replacement of [anchor + "\n      fields[index + 9] = '0'.repeat(64)", '      // mutation: persist regular-file ctime']) {
      await writeFile(subject, prepared.replace(anchor, replacement))
      const mutant = await run(suite, shared)
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain('(fail) shared dependency entrypoint hardlink churn')
      expect(mutant.output).toContain('error: expect(received)')
    }
    await writeFile(subject, prepared)
    const resolutionFilter = 'manifest-free suite identity|manifest resolution refuses'
    const resolutionControl = await run(suite, resolutionFilter)
    expect(resolutionControl.code, resolutionControl.output).toBe(0)
    expect(resolutionControl.output).toContain('2 pass')
    const parse = 'try { observations = JSON.parse(result.stdout) } catch { return null }'
    expect(prepared.split(parse)).toHaveLength(2)
    for (const [replacement, failed, assertion] of [
      ['observations = JSON.parse(result.stdout)', 'manifest-free suite identity', 'error: Received value must be a string: null'],
      ['try { observations = JSON.parse(result.stdout) } catch { observations = [] }', 'manifest resolution refuses', 'error: expect(received).toBeNull()'],
    ]) {
      await writeFile(subject, prepared.replace(parse, replacement!))
      const mutant = await run(suite, resolutionFilter)
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${failed}`)
      expect(mutant.output).toContain(assertion!)
      expect(mutant.output).not.toContain('SyntaxError: Unexpected')
    }
    await writeFile(helper, native)
    const filter = 'stable byte observations|during a pinned read|confined byte observation'
    const nativeControl = await run(probes, filter)
    expect(nativeControl.code, nativeControl.output).toBe(0)
    expect(nativeControl.output).toContain('8 pass')
    for (const [find, replacement, failed] of [
      ['digest.hexdigest()', "'0' * 64", 'stable byte observations'],
      [', observed.st_ctime_ns)', ')', 'a bytes change during a pinned read'],
      ['if signature(previous) != signature(observed):', 'if directory_identity(previous) != directory_identity(observed):', 'a namespace change during a pinned read'],
      ['root_fd = os.open(root,', "raise RuntimeError('mutation refuses every observation')\nroot_fd = os.open(root,", 'stable byte observations'],
    ]) {
      expect(native.split(find!)).toHaveLength(2)
      await writeFile(helper, native.replace(find!, replacement!))
      const mutant = await run(probes, filter)
      expect(mutant.code, mutant.output).not.toBe(0)
      expect(mutant.output).toContain(`(fail) ${failed}`)
      expect(mutant.output).toContain('Expected:')
      expect(mutant.output).not.toContain('SyntaxError')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 120_000)
