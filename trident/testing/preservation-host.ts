import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnCapture, type HostCommandResult } from '../git-mode.ts'
import type { RunHostCommand } from '../merge.ts'

/** Unit-host labels are not Git object identities. Translate them ONLY inside
 * this test adapter to a tiny real repository, then execute every snapshot and
 * integrity command. Production sees no adapter, synthetic pack or canned allow.
 * The default graph preserves the old work; `missing` is the negative control.
 */
export function preservationFixtureHost(root: string, mode: 'preserved' | 'missing' = 'preserved') {
  type Graph = { repo: string; prior: string; candidate: string }
  const graphs = new Map<number, Graph>()
  let labels = new Map<string, string>()
  async function graph(width: number): Promise<Graph> {
    const existing = graphs.get(width)
    if (existing) return existing
    const repo = await mkdtemp(join(root, `preservation-${width}-`))
    const git = async (...args: string[]) => {
      const result = await spawnCapture(['git', '-C', repo, ...args], root)
      if (!result.ok) throw Error(`preservation fixture failed: ${result.stderr}`)
      return result.stdout.trim()
    }
    await git('init', '-q', '--template=', `--object-format=${width === 64 ? 'sha256' : 'sha1'}`)
    await git('config', 'user.name', 'Fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    await git('config', 'commit.gpgsign', 'false')
    await git('config', 'core.hooksPath', '/dev/null')
    const commit = async (file: string) => {
      await writeFile(join(repo, file), `${file}\n`)
      await git('add', file)
      await git('commit', '-qm', 'Fixture content')
      return git('rev-parse', 'HEAD')
    }
    const base = await commit('base.txt')
    const prior = await commit('prior.txt')
    if (mode === 'missing') await git('switch', '--detach', base)
    const candidate = await commit('candidate.txt')
    const value = { repo, prior, candidate }
    graphs.set(width, value)
    return value
  }
  return async (...[cmd, , env, timeout]: Parameters<RunHostCommand>): Promise<HostCommandResult | undefined> => {
    // These are the preservation guard's isolated commands, not replay/drift or
    // trailer-scan probes that the scenario's ordinary host responder owns.
    if (env?.BASH_ENV !== '/dev/null' || env.GIT_GRAFT_FILE !== '/dev/null') return undefined
    let source: Graph | undefined
    if (cmd.includes('cat-file')) {
      const label = cmd.at(-1)!.replace(/\^\{commit\}$/, '')
      source = await graph(label.length)
      labels = new Map([[label, source.prior]])
    } else if (cmd.includes('pack-objects')) {
      const rootsPath = cmd[cmd.indexOf('--') + 3]!
      const [prior, candidate] = (await readFile(rootsPath, 'utf8')).trim().split('\n')
      if (!prior || !candidate) throw Error('preservation fixture requires both roots')
      source = await graph(candidate.length)
      labels = new Map([[prior, source.prior], [candidate, source.candidate]])
      await writeFile(rootsPath, `${source.prior}\n${source.candidate}\n`)
    }
    const translated = cmd.map((arg, index) => {
      if (source && cmd[index - 1] === '-C') return source.repo
      const match = arg.match(/^([0-9a-f]{40}|[0-9a-f]{64})(\^\{(?:commit|tree)\})?$/)
      return match && labels.has(match[1]!) ? `${labels.get(match[1]!)}${match[2] ?? ''}` : arg
    })
    const result = await spawnCapture(translated, root, env, timeout)
    // Only commit-name answers cross back into the unit scenario's symbolic
    // namespace. Pack IDs, trees, exit codes and validation failures stay real.
    if (result.ok && cmd.includes('rev-parse') && cmd.at(-1)?.endsWith('^{commit}')) {
      const label = [...labels].find(([, actual]) => actual === result.stdout.trim())?.[0]
      if (label) return { ...result, stdout: label }
    }
    return result
  }
}
