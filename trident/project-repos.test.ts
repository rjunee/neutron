import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProjectRepos, readProjectRepos, resolveProjectRepo, type ProjectRepos } from './project-repos.ts'
import { ensureProjectBuildWorkspace } from './build-workspace.ts'

const roots: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'project-repos-'))
  roots.push(home)
  const project = join(home, 'Projects', 'widgets')
  mkdirSync(project, { recursive: true })
  return { home, project }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const declaration = (): ProjectRepos => ({
  repos: [
    { name: 'widgets', path: 'code', remote: null },
    { name: 'docs', path: 'repos/docs', remote: null },
  ],
  default: 'widgets',
})

test('select named repo, default repo, and refuse unknown name with a real default present', () => {
  const repos = declaration()
  expect(resolveProjectRepo(repos).path).toBe('code')
  expect(resolveProjectRepo(repos, 'docs').path).toBe('repos/docs')
  expect(() => resolveProjectRepo(repos, 'missing')).toThrow('"missing"')
  repos.default = 'docs'
  expect(resolveProjectRepo(repos, null).name).toBe('docs')
})

test('zero repos is valid data but cannot resolve a build', () => {
  const repos = parseProjectRepos({ repos: [], default: null })
  expect(repos.repos).toEqual([])
  expect(() => resolveProjectRepo(repos)).toThrow('does not declare repo')
})

const invalid: [string, unknown][] = [
  ['shape', null],
  ['name', { repos: [{ name: '../escape', path: 'code', remote: null }], default: '../escape' }],
  ['duplicate name', { repos: [declaration().repos[0], { name: 'widgets', path: 'repos/widgets', remote: null }], default: 'widgets' }],
  ['path', { repos: [{ name: 'widgets', path: '../outside', remote: null }], default: 'widgets' }],
  ['remote', { repos: [{ name: 'widgets', path: 'code', remote: 3 }], default: 'widgets' }],
  ['duplicate path', { repos: [declaration().repos[0], { name: 'docs', path: 'code', remote: null }], default: 'widgets' }],
  ['default', { ...declaration(), default: 'missing' }],
]
for (const [name, value] of invalid) test(`reject invalid ${name}`, () => {
  expect(() => parseProjectRepos(value)).toThrow(name === 'shape' ? 'Invalid project repo declaration' : undefined)
  expect(parseProjectRepos(declaration()).repos).toHaveLength(2)
})

test('read every declaration; missing alone retains code and corruption refuses', () => {
  const { project } = fixture()
  expect(readProjectRepos(project, 'widgets')).toEqual({ repos: [declaration().repos[0]!], default: 'widgets' })
  const path = join(project, 'project-repos.json')
  writeFileSync(path, JSON.stringify(declaration()))
  expect(readProjectRepos(project, 'widgets')).toEqual(declaration())
  writeFileSync(path, '{')
  expect(() => readProjectRepos(project, 'widgets')).toThrow()
  rmSync(path)
  mkdirSync(path)
  expect(() => readProjectRepos(project, 'widgets')).toThrow()
})

test('real workspace selection preserves legacy repo and prepares named local repo', async () => {
  const { home, project } = fixture()
  const legacy = await ensureProjectBuildWorkspace(home, 'widgets')
  expect(legacy.build_repo_path).toBe(join(project, 'code'))
  writeFileSync(join(project, 'project-repos.json'), JSON.stringify(declaration()))
  expect((await ensureProjectBuildWorkspace(home, 'widgets')).created).toBe(false)
  const selected = await ensureProjectBuildWorkspace(home, 'widgets', undefined, 'docs')
  expect(selected.build_repo_path).toBe(join(project, 'repos', 'docs'))
  expect(existsSync(join(project, 'code', '.git'))).toBe(true)
  await expect(ensureProjectBuildWorkspace(home, 'widgets', undefined, 'missing')).rejects.toThrow('"missing"')
  expect(existsSync(join(project, 'repos', 'missing'))).toBe(false)
})

test('remote declaration refuses an absent checkout instead of initializing an unrelated repo', async () => {
  const { home, project } = fixture()
  const repos = declaration()
  repos.repos[1]!.remote = 'docs-origin'
  writeFileSync(join(project, 'project-repos.json'), JSON.stringify(repos))
  await expect(ensureProjectBuildWorkspace(home, 'widgets', undefined, 'docs')).rejects.toThrow('"docs" requires an existing checkout')
  expect(existsSync(join(project, 'repos'))).toBe(false)
  repos.repos[1]!.remote = null
  writeFileSync(join(project, 'project-repos.json'), JSON.stringify(repos))
  await ensureProjectBuildWorkspace(home, 'widgets', undefined, 'docs')
  repos.repos[1]!.remote = 'docs-origin'
  writeFileSync(join(project, 'project-repos.json'), JSON.stringify(repos))
  expect((await ensureProjectBuildWorkspace(home, 'widgets', undefined, 'docs')).created).toBe(false)
})
