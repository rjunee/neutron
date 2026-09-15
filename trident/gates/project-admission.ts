import type { BuildRunInput, GateResult } from '../build-run.ts'
import type { RunHostCommand } from '../merge.ts'

export interface AdmissionProject {
  runId: string
  repo: string
  branch: string
  baseBranch: string
  /** Read from this run's durable row, never a worker trailer. */
  prior: { base: string; head: string | null } | null
}
export interface AdmissionSource {
  observe(input: BuildRunInput): Promise<AdmissionProject | null>
  run: RunHostCommand
}
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
const blocked = (on: string): GateResult => ({ kind: 'blocked', on })

/** G016–G017. All ancestry operands are resolved OIDs; negative proof is depth-bracketed. */
export async function projectAdmission(source: AdmissionSource | undefined, input: BuildRunInput): Promise<GateResult> {
  if (!source) return unknown('Project admission observation source is missing')
  try {
    const project = await source.observe(input)
    if (!project || project.runId !== input.run_id || !project.repo) return unknown('Project admission run identity is missing or mismatched')
    const git = (...args: string[]) => source.run(['git', '-C', project.repo, ...args], project.repo)
    for (const ref of [project.branch, project.baseBranch]) {
      if (!ref || !(await git('check-ref-format', `refs/heads/${ref}`)).ok) return unknown('Project admission branch configuration is invalid')
    }
    const local = input.merge_mode === 'local'
    const baseRef = local ? `refs/heads/${project.baseBranch}` : `refs/remotes/origin/${project.baseBranch}`
    if (!local && !(await git('fetch', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${project.baseBranch}:${baseRef}`)).ok) return unknown('Project admission base could not be refreshed')
    const base = await git('rev-parse', '--verify', `${baseRef}^{commit}`)
    if (!base.ok || !oid.test(base.stdout.trim())) return unknown('Project admission base commit could not be resolved')
    const branchRef = `refs/heads/${project.branch}`
    const exists = await git('show-ref', '--verify', '--quiet', branchRef)
    if (!exists.ok) {
      if (exists.exit_code === 1 && exists.timed_out !== true) return { kind: 'allow' }
      return unknown('Project admission branch existence could not be measured')
    }
    const tip = await git('rev-parse', '--verify', `${branchRef}^{commit}`)
    if (!tip.ok || !oid.test(tip.stdout.trim())) return unknown('Project admission branch tip could not be resolved')
    const complete = async () => {
      const depth = await git('rev-parse', '--is-shallow-repository')
      return depth.ok && depth.stdout.trim() === 'false'
    }
    const ancestry = async (from: string, to: string): Promise<'yes' | 'no' | 'unknown'> => {
      const probe = await git('merge-base', '--is-ancestor', from, to)
      if (probe.ok) return 'yes'
      if (probe.exit_code !== 1 || probe.timed_out === true || !(await complete())) return 'unknown'
      const confirm = await git('merge-base', '--is-ancestor', from, to)
      if (confirm.ok) return 'yes'
      if (confirm.exit_code !== 1 || confirm.timed_out === true || !(await complete())) return 'unknown'
      return 'no'
    }
    const contained = await ancestry(tip.stdout.trim(), base.stdout.trim())
    if (contained === 'unknown') return unknown('Project admission ancestry is unknown; history may be shallow or unreadable')
    if (contained === 'yes') return { kind: 'allow' }
    if (project.prior === null) return blocked('Project branch is not contained in the base and has no prior run ownership')
    if (!oid.test(project.prior.base) || (project.prior.head !== null && !oid.test(project.prior.head))) return unknown('Project admission prior run pins are malformed')
    const prior = await ancestry(project.prior.base, tip.stdout.trim())
    if (prior === 'unknown') return unknown('Project admission prior base ancestry is unknown')
    if (prior === 'no') return blocked('Project branch does not descend from this run prior base')
    if (project.prior.head !== null) {
      const present = await git('cat-file', '-e', `${project.prior.head}^{commit}`)
      // Preserve the old unreadable-object exception; a readable checkpoint requires ownership.
      if (present.ok) {
        const owned = await ancestry(project.prior.head, tip.stdout.trim())
        if (owned === 'unknown') return unknown('Project admission recorded head ancestry is unknown')
        if (owned === 'no') return blocked('Project branch does not contain this run recorded head')
      }
    }
    return { kind: 'allow' }
  } catch { return unknown('Project admission host observation failed') }
}
