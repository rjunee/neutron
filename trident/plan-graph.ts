/**
 * @neutronai/trident — node-free plan DAG leaf.
 *
 * Grammar: task lines match `/^[ \t]*- \[( |x)\] /` (`x` means checked).
 * A graph task is `- [ ] T<n>: <title>` followed by optional, case-sensitive
 * ` | requires: none|T<i>, T<j>` and ` | surface: <path>, <path>` fields, each
 * occurring at most once. The first ` | ` on an id-bearing line starts its
 * fields, so a graph-task title cannot contain ` | `. Any checklist line
 * without a valid `T<digits>:` prefix is a legacy task with a synthetic
 * `L<lineIndex>` id. Non-checklist lines are ignored.
 *
 * An absent `requires` field means INDEPENDENT, never "depends on the previous
 * line". An absent `surface` means the task can never share a wave: undeclared
 * surface => conservative wave size 1. Malformed paths overlap everything.
 * Legacy plain lines parse error-free into exactly today's serial behaviour:
 * they are independent but surface-undeclared, so each wave has size 1.
 */

export type PlanGraphErrorKind = 'cycle' | 'unknown-id' | 'duplicate-id' | 'bad-field'

export class PlanGraphError extends Error {
  readonly kind: PlanGraphErrorKind

  constructor(kind: PlanGraphErrorKind, message: string) {
    super(message)
    this.name = 'PlanGraphError'
    this.kind = kind
  }
}

export interface PlanTask {
  id: string
  title: string
  checked: boolean
  requires: string[]
  requiresDeclared: boolean
  surfaces: string[]
  line: number
  raw: string
}

function badField(id: string, segment: string): never {
  throw new PlanGraphError('bad-field', `Bad field on plan task ${id}: ${segment}`)
}

function validateGraph(tasks: readonly PlanTask[]): void {
  const graphTasks = new Map(tasks.filter((task) => task.id.startsWith('T')).map((task) => [task.id, task]))

  for (const task of graphTasks.values()) {
    for (const dependency of task.requires) {
      if (!graphTasks.has(dependency)) {
        throw new PlanGraphError(
          'unknown-id',
          `Plan task ${task.id} requires unknown id ${dependency}`,
        )
      }
    }
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const path: string[] = []

  function visit(id: string): void {
    const existing = state.get(id)
    if (existing === 'visited') return
    if (existing === 'visiting') {
      const cycleStart = path.indexOf(id)
      const cycle = [...path.slice(cycleStart), id]
      throw new PlanGraphError('cycle', `Dependency cycle: ${cycle.join(' -> ')}`)
    }

    state.set(id, 'visiting')
    path.push(id)
    for (const dependency of graphTasks.get(id)!.requires) visit(dependency)
    path.pop()
    state.set(id, 'visited')
  }

  for (const id of graphTasks.keys()) visit(id)
}

export function parsePlanGraph(body: string): PlanTask[] {
  const tasks: PlanTask[] = []
  const graphIds = new Set<string>()

  for (const [line, raw] of body.split('\n').entries()) {
    const checkbox = raw.match(/^[ \t]*- \[( |x)\] /)
    if (!checkbox) continue

    const checked = checkbox[1] === 'x'
    const text = raw.slice(checkbox[0].length).replace(/\r$/, '')
    const segments = text.split(' | ')
    const graphHead = segments[0]!.match(/^(T\d+):(.*)$/)

    if (!graphHead) {
      tasks.push({
        id: `L${line}`,
        title: text,
        checked,
        requires: [],
        requiresDeclared: false,
        surfaces: [],
        line,
        raw,
      })
      continue
    }

    const id = graphHead[1]!
    if (graphIds.has(id)) {
      throw new PlanGraphError('duplicate-id', `Duplicate plan task id: ${id}`)
    }
    graphIds.add(id)

    let requires: string[] = []
    let requiresDeclared = false
    let surfaces: string[] = []
    let surfaceDeclared = false

    for (const segment of segments.slice(1)) {
      if (segment.startsWith('requires: ')) {
        if (requiresDeclared) badField(id, segment)
        requiresDeclared = true
        const value = segment.slice('requires: '.length)
        if (value === 'none') continue
        const dependencies = value.split(',').map((dependency) => dependency.trim())
        if (
          dependencies.length === 0 ||
          dependencies.some(
            (dependency) => dependency.length === 0 || !/^(?:T|L)\d+$/.test(dependency),
          )
        ) {
          badField(id, segment)
        }
        requires = dependencies
        continue
      }

      if (segment.startsWith('surface: ')) {
        if (surfaceDeclared) badField(id, segment)
        surfaceDeclared = true
        const paths = segment
          .slice('surface: '.length)
          .split(',')
          .map((path) => path.trim())
        if (paths.length === 0 || paths.some((path) => path.length === 0)) badField(id, segment)
        surfaces = paths
        continue
      }

      badField(id, segment)
    }

    const titleText = graphHead[2]!
    tasks.push({
      id,
      title: titleText.startsWith(' ') ? titleText.slice(1) : titleText,
      checked,
      requires,
      requiresDeclared,
      surfaces,
      line,
      raw,
    })
  }

  validateGraph(tasks)
  return tasks
}

function normalizeSurface(path: string): string {
  let normalized = path.trim()
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized.replace(/\/+/g, '/').replace(/\/$/, '')
}

function malformedSurface(path: string): boolean {
  return path.length === 0 || path.startsWith('/') || path.split('/').includes('..')
}

export function surfacesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = a.map(normalizeSurface)
  const right = b.map(normalizeSurface)
  if (left.some(malformedSurface) || right.some(malformedSurface)) return true

  return left.some((x) =>
    right.some((y) => x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)),
  )
}

export function computeWave(tasks: readonly PlanTask[], maxWaveSize: number): PlanTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const eligible = tasks.filter(
    (task) => !task.checked && task.requires.every((dependency) => byId.get(dependency)?.checked === true),
  )
  if (eligible.length === 0) return []

  const first = eligible[0]!
  if (first.surfaces.length === 0) return [first]

  const limit = maxWaveSize < 1 ? 1 : Math.floor(maxWaveSize)
  const wave: PlanTask[] = [first]
  for (const task of eligible.slice(1)) {
    if (wave.length >= limit) break
    if (
      task.surfaces.length > 0 &&
      wave.every((member) => !surfacesOverlap(task.surfaces, member.surfaces))
    ) {
      wave.push(task)
    }
  }
  return wave
}

export function renderCheckedOff(body: string, ids: readonly string[]): string {
  const tasks = parsePlanGraph(body)
  const byId = new Map(tasks.map((task) => [task.id, task]))

  for (const id of ids) {
    if (!byId.has(id)) throw new PlanGraphError('unknown-id', `Plan task id not found: ${id}`)
  }

  const requested = new Set(ids)
  const lines = body.split('\n')
  for (const task of tasks) {
    if (task.checked || !requested.has(task.id)) continue
    const checkbox = task.raw.indexOf('[ ]')
    lines[task.line] = `${task.raw.slice(0, checkbox)}[x]${task.raw.slice(checkbox + 3)}`
  }
  return lines.join('\n')
}
