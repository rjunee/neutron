/** Deterministic workload units, never milliseconds, prices or live token estimates.
 * Historical scheduling evidence: docs/spec-items/trident-build-efficiency.md:54-67
 * pins the serial seat, session and outer-review barriers to revision 7d5ca4bd.
 * The baseline is a controlled reconstruction of that scheduling constraint over
 * today's identical task/gates; it is not a replay of the live run's timing.
 */
export const EFFICIENCY_SCENARIOS = ['fresh', 'code-fix', 'unchanged-head', 'moved-head', 'interruption', 'pending-interruption'] as const
export type EfficiencyScenario = typeof EFFICIENCY_SCENARIOS[number]
export type BenchmarkInterval = { stage: string; start: number; end: number }
/** Compare the scripted workload, not run IDs, temporary paths or generated SHAs.
 * Models come from admitted attempts, including the distinct review seats. */
export interface EfficiencyScope {
  fixture: string
  task: string
  gates: {
    observed: string[]
    suite_strategy: string
    intermediate_strategy: string | null
    max_rounds: number
    merge_mode: string
  }
  models: Array<{ role: string; seat: string | null; provider: string;
    requested: string; resolved: string; placement: string }>
}
export class EfficiencyTrace {
  readonly intervals: BenchmarkInterval[] = []
  readonly decisions: string[] = []
  private clock = 0
  begin(stage: string, units = 1): () => void {
    const start = this.clock
    return () => {
      const end = Math.max(this.clock, start + units)
      this.clock = end
      this.intervals.push({ stage, start, end })
    }
  }
  async during<T>(stage: string, action: () => Promise<T>, units = 1): Promise<T> {
    const end = this.begin(stage, units)
    try { return await action() } finally { end() }
  }
}
export interface EfficiencyReport {
  scope: EfficiencyScope | null
  timing_unit: 'scripted-workload-unit'
  barrier_complete: boolean
  scenario: EfficiencyScenario
  scheduling: 'serial-baseline' | 'concurrent'
  counts: { plan: number; build: number; fix: number; review: number; synthesis: number; install: number; verify: number; proof: number }
  decisions: string[]
  intervals: BenchmarkInterval[]
  outcomes: string[]
  usage: { tokens: null; cost: null; source: 'scripted-provider-no-usage' }
}

export type EfficiencyComparison = { kind: 'matched' } | { kind: 'unmatched'; reasons: string[] }

/** An unmatched workload is reportable, but supplies no efficiency comparison.
 * Gate/outcome drift within a matched workload is a regression, not a saving. */
export function compareEfficiency(before: EfficiencyReport, after: EfficiencyReport): EfficiencyComparison {
  const reasons: string[] = []
  if (before.scenario !== after.scenario) reasons.push('scenario')
  if (before.timing_unit !== after.timing_unit) reasons.push('timing unit')
  if (!before.scope || !after.scope) reasons.push('missing scope')
  else {
    if (before.scope.fixture !== after.scope.fixture || !before.scope.fixture || !after.scope.fixture) reasons.push('scripted fixture')
    if (before.scope.task !== after.scope.task || !before.scope.task || !after.scope.task) reasons.push('task')
    const gates = ({ gates }: EfficiencyScope) => JSON.stringify([
      [...gates.observed].sort(), gates.suite_strategy, gates.intermediate_strategy, gates.max_rounds, gates.merge_mode,
    ])
    if (!before.scope.gates.observed.length || !after.scope.gates.observed.length || gates(before.scope) !== gates(after.scope)) reasons.push('gates')
    // Scheduling and repeated calls may alter order/count, never the set of
    // model/seat assignments. Dispatch-count acceptance remains independent.
    const models = (scope: EfficiencyScope) => JSON.stringify([...new Set(scope.models.map(model => JSON.stringify([
      model.role, model.seat, model.provider, model.requested, model.resolved, model.placement,
    ])))].sort())
    if (!before.scope.models.length || !after.scope.models.length || models(before.scope) !== models(after.scope)) reasons.push('models')
  }
  if (reasons.length) return { kind: 'unmatched', reasons }
  if (JSON.stringify(before.decisions) !== JSON.stringify(after.decisions)
      || JSON.stringify(before.outcomes) !== JSON.stringify(after.outcomes)) throw Error('Equivalent scope changed gate decisions or outcomes')
  return { kind: 'matched' }
}

/** Fail on extra work AND on skipping required work. Counts are per complete
 * scenario, including the first process and any recovered process. */
export function assertEfficient(report: EfficiencyReport): void {
  if (!report.barrier_complete) throw Error('Independent review barrier did not fill')
  const rounds = report.scenario === 'code-fix' || report.scenario === 'moved-head' ? 2 : 1
  const builds = report.scenario === 'moved-head' ? 2 : 1
  const expected = { plan: builds, build: builds, fix: report.scenario === 'code-fix' ? 1 : 0,
    review: rounds * 3, synthesis: rounds }
  for (const [key, count] of Object.entries(expected)) {
    if (report.counts[key as keyof typeof expected] !== count) throw Error(`Unexpected ${key} dispatch count for ${report.scenario}`)
  }
  const reviews = report.intervals.filter(value => value.stage.startsWith('review:'))
  for (let index = 0; index < reviews.length; index += 3) {
    const group = reviews.slice(index, index + 3)
    if (group.length !== 3 || Math.max(...group.map(value => value.start)) >= Math.min(...group.map(value => value.end))) {
      throw Error('Independent reviews serialized')
    }
  }
  if (reviews.length !== expected.review) throw Error('Missing review interval')
  const recovered = ['unchanged-head', 'moved-head', 'interruption', 'pending-interruption'].includes(report.scenario)
  if (report.counts.install !== (recovered ? 2 : 1) || report.counts.verify !== (recovered ? 3 : 2)
      || report.counts.proof !== rounds) throw Error('Unexpected preparation or proof count')
  const expectedOutcomes = report.scenario === 'pending-interruption' ? ['blocked', 'merged']
    : recovered ? ['unknown', 'merged'] : ['merged']
  if (JSON.stringify(report.outcomes) !== JSON.stringify(expectedOutcomes)) throw Error('Gate outcome changed')
}
