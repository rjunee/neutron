/**
 * THE UNION TEST: every agent the workflow spawns is either owner-configurable or
 * deliberately not, and nothing falls through by accident.
 *
 * WHY THIS EXISTS AS A WALKING TEST. `phase-models.ts` and `inner-workflow.mjs` are two
 * files that have to agree about a set of strings, and neither can import the other —
 * the workflow script has no module resolution, which is why model ids arrive as
 * arguments in the first place. Two files that must agree, with no compiler between
 * them, is precisely the shape where both suites stay green while their union is
 * broken. So the check reads one file's SOURCE and compares it against the other's
 * exported table.
 *
 * IT EARNED ITS PLACE ON THE FIRST RUN. `head-probe-round-N` — a step whose whole job
 * is to run one `git` command and report the sha it printed — was absent from the
 * routing table and therefore resolved to the fallback, which is the most expensive
 * tier at HIGH effort. It had been that way since the step was introduced. Nothing
 * could have noticed, because a missing entry and a deliberate entry produce identical
 * behaviour when the fallback is silent. This test makes the two distinguishable: a
 * label is claimed by a phase, or it is listed as unrouted WITH A REASON, or CI is red.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not assert which model any phase uses.
 * That is configuration, it is meant to change, and pinning it here would make every
 * routing decision a two-file edit for no safety gain. What must not change silently
 * is COVERAGE.
 */

import { describe, expect, it } from 'bun:test'

import {
  EFFORTS,
  MODEL_TIERS,
  TRIDENT_PHASES,
  UNROUTED_LABELS,
  isEffort,
  isModelTier,
  isPhaseKey,
  isUnroutedLabel,
  parsePhaseModelConfig,
  phaseByKey,
  phaseForLabel,
  phaseModelDefaults,
} from '../phase-models.ts'

const WORKFLOW_SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

/**
 * Every `label:` literal in the workflow source, with `${…}` interpolations reduced to
 * their static prefix (`head-probe-round-${round}` → `head-probe-round-`).
 *
 * Reading the source rather than executing the workflow is the point: the labels are
 * scattered across call sites inside a script that spawns real agents, and there is no
 * way to enumerate them at runtime without running a build.
 */
function labelsInWorkflow(): string[] {
  // COMMENTS ARE STRIPPED FIRST. This test's own docblock says the words "`label:`
  // literals", and the workflow's routing table has a comment doing the same — so a
  // naive scan matched the PROSE. Both fixes below came from that first run:
  //
  //   1. Strip comment lines, because a check on source text must look at code. (The
  //      same mistake in the other direction bit a source check earlier the same day,
  //      where a comment explaining a removed expression was flagged as the
  //      regression.)
  //   2. Forbid a NEWLINE inside the captured label. Without that, the unterminated
  //      quote in a comment let `[^`'"]*` run on to the next backtick several lines
  //      later and swallow a block of source as a "label" — an unscoped regex reading
  //      far past the construct it was aimed at.
  const code = WORKFLOW_SRC.split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  const out = new Set<string>()
  const re = /label:\s*[`'"]([^`'"\n]*)[`'"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const raw = m[1] ?? ''
    const idx = raw.indexOf('${')
    out.add(idx >= 0 ? raw.slice(0, idx) : raw)
  }
  return [...out].filter((l) => l.length > 0)
}

describe('the extractor itself works (positive control)', () => {
  it('finds labels that are definitely in the workflow', () => {
    // WITHOUT THIS CONTROL a regex that matched nothing would report perfect
    // coverage — the failure mode where the tool cannot read the format and its
    // silence reads as a pass.
    const labels = labelsInWorkflow()
    expect(labels.length).toBeGreaterThanOrEqual(10)
    expect(labels).toContain('argus:claude')
    expect(labels).toContain('forge:build')
    expect(labels).toContain('plan:fable')
  })

  it('reduces an interpolated label to its static prefix', () => {
    const labels = labelsInWorkflow()
    // The dynamic ones must arrive as prefixes, or the coverage comparison below
    // would be matching against literal `${round}` text.
    expect(labels).toContain('forge:fix-round-')
    expect(labels).toContain('head-probe-round-')
    expect(labels.some((l) => l.includes('${'))).toBe(false)
  })
})

describe('coverage — no label falls through silently', () => {
  it('every workflow label is claimed by a phase OR listed as unrouted', () => {
    const uncovered = labelsInWorkflow().filter(
      (label) => phaseForLabel(label) === null && !isUnroutedLabel(label),
    )
    // Named in the message, because "0 !== 1" would not tell the next person WHICH
    // agent they just made unconfigurable.
    expect({ uncovered }).toEqual({ uncovered: [] })
  })

  it('head-probe specifically is routed — the regression this test was written for', () => {
    const phase = phaseForLabel('head-probe-round-4')
    expect(phase).not.toBeNull()
    expect(phase!.key).toBe('bookkeeping')
  })

  it('every phase claims at least one label that actually exists in the workflow', () => {
    // The other direction: a phase covering nothing is DEAD configuration — the owner
    // sets it, nothing changes, and the feature looks broken rather than absent.
    const workflowLabels = labelsInWorkflow()
    const dead = TRIDENT_PHASES.filter(
      (phase) =>
        !phase.labels.some((entry) =>
          entry.dynamic === true
            ? workflowLabels.includes(entry.label)
            : workflowLabels.includes(entry.label),
        ),
    ).map((p) => p.key)
    expect({ dead }).toEqual({ dead: [] })
  })

  it('every unrouted label still exists in the workflow, and says why it is excluded', () => {
    // An exclusion for a label that no longer exists is stale permission to ignore
    // something — it would keep a future lane of the same name silently unconfigurable.
    const workflowLabels = labelsInWorkflow()
    const stale = UNROUTED_LABELS.filter((e) => !workflowLabels.includes(e.label)).map(
      (e) => e.label,
    )
    expect({ stale }).toEqual({ stale: [] })
    for (const entry of UNROUTED_LABELS) {
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })

  it('no label is BOTH claimed and excluded', () => {
    const conflicting = labelsInWorkflow().filter(
      (label) => phaseForLabel(label) !== null && isUnroutedLabel(label),
    )
    expect({ conflicting }).toEqual({ conflicting: [] })
  })
})

describe('the workflow reads the argument this module produces', () => {
  it('destructures phaseModels and applies it in the router', () => {
    // The seam, asserted from the consuming side. Without this, `phase-models.ts`
    // could be perfect and completely unwired — the recurring failure in this repo.
    expect(WORKFLOW_SRC.includes('phaseModels = null')).toBe(true)
    expect(WORKFLOW_SRC.includes('applyPhaseOverride')).toBe(true)
    expect(WORKFLOW_SRC.includes('return applyPhaseOverride(base, base.phaseKey)')).toBe(true)
  })

  it('keeps the owner-facing phase key OUT of the agent opts', () => {
    // `agent()` opts already carry a `phase` field meaning the progress group, so the
    // config key is `phaseKey` and only model+effort may cross into a spawn. A leak
    // here would put an unrecognised field on every spawn.
    expect(WORKFLOW_SRC.includes('return { ...opts, model: route.model, effort: route.effort }')).toBe(
      true,
    )
  })

  it('routes every phase key the table declares', () => {
    // Each phase key must appear in the workflow's routing table, or an override for
    // it can never be looked up.
    for (const phase of TRIDENT_PHASES) {
      expect(WORKFLOW_SRC.includes(`phaseKey: '${phase.key}'`)).toBe(true)
    }
  })
})

describe('validation rejects loudly rather than dropping quietly', () => {
  it('accepts a well-formed config', () => {
    const { config, errors } = parsePhaseModelConfig({
      build: { model: 'opus', effort: 'xhigh' },
      synthesis: { effort: 'max' },
    })
    expect(errors).toEqual([])
    expect(config).toEqual({ build: { model: 'opus', effort: 'xhigh' }, synthesis: { effort: 'max' } })
  })

  it('rejects an unknown phase and NAMES the valid ones', () => {
    const { config, errors } = parsePhaseModelConfig({ arbitration: { effort: 'max' } })
    expect(config).toEqual({})
    expect(errors).toHaveLength(1)
    // The message has to be actionable: "unknown phase" alone sends the owner to the
    // source to find the spelling.
    expect(errors[0]).toContain('arbitration')
    expect(errors[0]).toContain('synthesis')
  })

  it('rejects an effort outside the scale, and says what it got', () => {
    const { config, errors } = parsePhaseModelConfig({ build: { effort: 'ultra' } })
    expect(config).toEqual({})
    expect(errors[0]).toContain('ultra')
    expect(errors[0]).toContain('xhigh')
  })

  it('rejects an unknown FIELD rather than ignoring it', () => {
    // Ignoring an unknown field is how `{ build: { modle: 'opus' } }` becomes a
    // config the owner believes is applied.
    const { config, errors } = parsePhaseModelConfig({ build: { modle: 'opus' } })
    expect(config).toEqual({})
    expect(errors[0]).toContain('modle')
  })

  it('rejects an empty model string and tells the owner how to clear a phase', () => {
    const { errors } = parsePhaseModelConfig({ build: { model: '   ' } })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('omit the phase')
  })

  it('rejects a model id with control characters or absurd length', () => {
    expect(parsePhaseModelConfig({ build: { model: 'op us' } }).errors).toHaveLength(1)
    expect(parsePhaseModelConfig({ build: { model: 'x'.repeat(200) } }).errors).toHaveLength(1)
  })

  it('accepts a LITERAL model id, not just a tier name', () => {
    // The escape hatch: pinning an exact vendor id is sometimes the whole point, and
    // a regex over vendor naming would reject valid future ids.
    const { config, errors } = parsePhaseModelConfig({ build: { model: 'gpt-5.6-sol' } })
    expect(errors).toEqual([])
    expect(config['build']).toEqual({ model: 'gpt-5.6-sol' })
    expect(isModelTier('gpt-5.6-sol')).toBe(false)
  })

  it('drops an entry that sets nothing, so {} never persists as configuration', () => {
    const { config, errors } = parsePhaseModelConfig({ build: {} })
    expect(errors).toEqual([])
    expect(config).toEqual({})
  })

  it('treats null/undefined as "no configuration", not as an error', () => {
    expect(parsePhaseModelConfig(null)).toEqual({ config: {}, errors: [] })
    expect(parsePhaseModelConfig(undefined)).toEqual({ config: {}, errors: [] })
  })

  it('rejects a non-object at the top level, including an array', () => {
    expect(parsePhaseModelConfig([]).errors).toHaveLength(1)
    expect(parsePhaseModelConfig('build=opus').errors).toHaveLength(1)
  })

  it('keeps the valid entries and reports only the bad one', () => {
    // Partial acceptance is right HERE (the caller fails the write on non-empty
    // errors) and wrong in the workflow, which must never abort a build over config.
    const { config, errors } = parsePhaseModelConfig({
      build: { model: 'opus' },
      nonsense: { effort: 'max' },
    })
    expect(config).toEqual({ build: { model: 'opus' } })
    expect(errors).toHaveLength(1)
  })
})

describe('the vocabulary a settings pane will render', () => {
  it('exposes defaults derived from the phase table, never restated', () => {
    const defaults = phaseModelDefaults()
    expect(Object.keys(defaults).sort()).toEqual(TRIDENT_PHASES.map((p) => p.key).sort())
    for (const phase of TRIDENT_PHASES) {
      expect(defaults[phase.key]).toEqual({
        model: phase.default.tier,
        effort: phase.default.effort,
      })
    }
  })

  it('gives every phase a stable key, a label and a real description', () => {
    for (const phase of TRIDENT_PHASES) {
      expect(isPhaseKey(phase.key)).toBe(true)
      expect(phaseByKey(phase.key)).toBe(phase)
      expect(phase.label.length).toBeGreaterThan(0)
      // A row with no subtitle is a control the owner has to guess the meaning of.
      expect(phase.description.length).toBeGreaterThan(20)
      expect(isModelTier(phase.default.tier)).toBe(true)
      expect(isEffort(phase.default.effort)).toBe(true)
    }
  })

  it('has no duplicate phase keys', () => {
    const keys = TRIDENT_PHASES.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('orders efforts low → high so a UI can render them as a scale', () => {
    expect(EFFORTS[0]).toBe('low')
    expect(EFFORTS[EFFORTS.length - 1]).toBe('max')
  })

  it('resolves the two build phases apart by TAG, not by label', () => {
    // Both build phases claim the same labels on purpose; the planner's complexity
    // tag chooses between them. `phaseForLabel` must therefore answer `build`, and
    // never `build_mechanical`, so the tag stays the only discriminator.
    expect(phaseForLabel('forge:build')!.key).toBe('build')
    expect(phaseForLabel('forge:fix-round-2')!.key).toBe('build')
    expect(phaseByKey('build_mechanical')).not.toBeNull()
    expect(MODEL_TIERS).toContain(phaseByKey('build_mechanical')!.default.tier)
  })
})

describe('the args actually carry it (the TS half, end to end)', () => {
  /**
   * `buildWorkflowArgs` is the last typed layer before the config becomes JSON inside
   * a launcher prompt, so this is the highest-value place to assert behaviour rather
   * than source text. Everything below runs the real builder.
   */
  const makeInput = async (
    phase_models: Record<string, { model?: string; effort?: string }> | null,
  ) => {
    const { buildWorkflowArgs } = await import('../inner-loop.ts')
    return buildWorkflowArgs({
      run: {
        id: 'run-1',
        slug: 'a-run',
        task: 'do the thing',
        repo_path: '/repo',
        worktree: null,
        branch: null,
        pr: null,
      } as never,
      base_branch: 'main',
      db_path: '/tmp/project.db',
      max_rounds: 3,
      ...(phase_models !== null ? { phase_models } : {}),
    })
  }

  it('threads a valid override through to the workflow args', async () => {
    const args = await makeInput({ build: { model: 'opus', effort: 'xhigh' } })
    expect(args['phaseModels']).toEqual({ build: { model: 'opus', effort: 'xhigh' } })
  })

  it('OMITS the key entirely when nothing is configured', async () => {
    // Not `phaseModels: {}`. An empty object in the payload is a diff with no
    // behaviour, and a run on an instance that never touched the setting should
    // produce the args it always did — which is also what makes a payload
    // trustworthy when something DOES go wrong.
    const args = await makeInput(null)
    expect('phaseModels' in args).toBe(false)
  })

  it('DROPS an invalid entry rather than forwarding it to a layer that can only log', async () => {
    // The workflow's only recourse is log-and-continue, and a log line in a
    // background run is not a channel the owner reads. So the typed boundary is the
    // last place this can be stopped, and it stops it.
    const args = await makeInput({ build: { effort: 'ultra' as never } })
    expect('phaseModels' in args).toBe(false)
  })

  it('keeps the good half of a partly-invalid config', async () => {
    const args = await makeInput({
      build: { model: 'opus' },
      nonsense: { effort: 'max' },
    } as never)
    expect(args['phaseModels']).toEqual({ build: { model: 'opus' } })
  })

  it('still threads the model TIER map — the seam this rides on is unchanged', async () => {
    const args = await makeInput({ build: { model: 'opus' } })
    const models = args['models'] as Record<string, string>
    // A regression here would mean the phase override resolves a tier name against
    // nothing, silently producing the literal string 'opus' as a model id.
    for (const tier of MODEL_TIERS) {
      expect(typeof models[tier]).toBe('string')
      expect(models[tier]!.length).toBeGreaterThan(0)
    }
  })
})
