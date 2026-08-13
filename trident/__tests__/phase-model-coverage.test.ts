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
import { TIER_GROUPS } from '../model-tiers.ts'

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

  it('the cross-model lanes are ROUTED now, retries included', () => {
    // They used to be listed as deliberately unconfigurable ("the reviewing model is
    // the CLI's own configuration"), which held only while nothing threaded a model
    // IN. Both wrappers read an env knob, so the exclusion was retired — and the
    // RETRY lanes matter as much as the first attempt: an owner's choice that applied
    // to one and not the other would be a review served by two different models.
    for (const label of ['argus:codex', 'argus:codex-retry']) {
      expect(phaseForLabel(label)?.key).toBe('review_codex')
      expect(isUnroutedLabel(label)).toBe(false)
    }
    for (const label of ['argus:kimi', 'argus:kimi-retry']) {
      expect(phaseForLabel(label)?.key).toBe('review_kimi')
      expect(isUnroutedLabel(label)).toBe(false)
    }
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

  it('implements every `follows` the table declares, and no other', () => {
    // THE DRIFT GUARD FOR THE ONE RULE THAT LIVES IN TWO PLACES. `follows` decides two
    // things that must agree: the surface hides the row, and the workflow's
    // `phaseOverrideFor` hands it the followed phase's override. The `.mjs` cannot
    // import this module (the workflow script has no module resolution), so the rule
    // is necessarily restated there — and a restatement nobody checks is how the pane
    // and the run start disagreeing.
    const declared = TRIDENT_PHASES.filter((p) => p.follows !== undefined)
    // The table must actually declare one, or every assertion below is vacuous.
    expect(declared.map((p) => `${p.key}<-${p.follows}`)).toEqual(['build_mechanical<-build'])
    for (const phase of declared) {
      // MATCHED AS A PATTERN, not as a literal block of source. The previous version
      // pinned a multi-line substring including its indentation, so a reformat broke
      // the guard with no behaviour change — and a guard that cries wolf gets deleted.
      expect(
        new RegExp(
          `phaseKey === '${phase.key}'\\s*\\?\\s*threadedPhaseModels\\['${phase.follows!}'\\]`,
        ).test(WORKFLOW_SRC),
      ).toBe(true)
      // AND THE MIRROR IS UNCONDITIONAL. A read of the follower's OWN key would give a
      // stored-but-unrenderable entry precedence over the row the owner can actually
      // see — the setting would be pinned somewhere they cannot reach it.
      expect(WORKFLOW_SRC.includes(`threadedPhaseModels['${phase.key}']`)).toBe(false)
    }
    // And a phase with NO `follows` must not be quietly inheriting anyway.
    for (const phase of TRIDENT_PHASES) {
      if (phase.follows !== undefined) continue
      expect(new RegExp(`phaseKey === '${phase.key}'\\s*(\\?|&&)`).test(WORKFLOW_SRC)).toBe(false)
    }
  })

  it('implements every `alsoRunsOn` the table declares, and no other', () => {
    // THE SECOND RULE THAT LIVES IN TWO PLACES, and it had no guard while the module
    // header claimed one. `alsoRunsOn` is what makes a tier from another executor
    // SELECTABLE for a phase; the workflow's route for that phase has to carry the
    // same list, or `applyPhaseOverride` logs IGNORED and the owner's pick dispatches
    // nowhere — a settable option that does nothing, which is worse than a greyed one.
    const declared = TRIDENT_PHASES.filter((p) => (p.alsoRunsOn?.length ?? 0) > 0)
    // Not vacuous: the table declares these today.
    expect(declared.map((p) => p.key).sort()).toEqual([
      'build',
      'build_mechanical',
      'review_adversarial',
    ])
    for (const phase of declared) {
      // The route carrying this phase key must list the same groups.
      const route = new RegExp(
        `phaseKey: '${phase.key}'[^}]*alsoRunsOn: \\[([^\\]]*)\\]`,
      ).exec(WORKFLOW_SRC)
      expect({ key: phase.key, routed: route !== null }).toEqual({ key: phase.key, routed: true })
      const groups = route![1]!
        .split(',')
        .map((g) => g.trim().replace(/^'|'$/g, ''))
        .filter((g) => g.length > 0)
      expect({ key: phase.key, groups }).toEqual({ key: phase.key, groups: [...phase.alsoRunsOn!] })
      // …and every group named is one the workflow can actually DISPATCH: it needs a
      // route of its own carrying that group, or the move lands on nothing.
      for (const group of phase.alsoRunsOn!) {
        expect(TIER_GROUPS).toContain(group)
        expect(new RegExp(`group: '${group}'`).test(WORKFLOW_SRC)).toBe(true)
      }
    }
    // A phase the table does NOT widen must not be widened in the workflow either —
    // that direction un-greys nothing, but it would let an override past the group
    // check that the pane would never have offered.
    const widenedInWorkflow = [...WORKFLOW_SRC.matchAll(/phaseKey: '([a-z_]+)'[^}]*alsoRunsOn:/g)]
      .map((m) => m[1]!)
      .sort()
    expect([...new Set(widenedInWorkflow)]).toEqual(declared.map((p) => p.key).sort())
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
    // WRITTEN AS AN ESCAPE, NOT A LITERAL BYTE -- and the first version of this line
    // was a literal NUL, which made the whole file BINARY to grep. The leak gate
    // caught it as `binary-hidden` and was right to fail: a NUL byte does not just
    // look odd, it makes every PII and vocabulary rule SKIP the file silently, so a
    // single invisible character disables the scanner for everything else in it.
    // `phase-models.ts` carries the same warning about its own regex; I wrote the
    // warning and then made the mistake in the test one screen later.
    expect(parsePhaseModelConfig({ build: { model: 'op\u0000us' } }).errors).toHaveLength(1)
    expect(parsePhaseModelConfig({ build: { model: 'x'.repeat(200) } }).errors).toHaveLength(1)
  })

  it('REJECTS a literal vendor id — a tier or nothing', () => {
    // The old escape hatch, closed deliberately. A bare id carries no TRANSPORT, so
    // `gpt-5.6-sol` in the build phase looked like a pin and was really a
    // Claude-endpoint lookup for a model only reachable as a subprocess: a build that
    // quietly runs on the wrong model. The message has to name the vocabulary,
    // because "invalid" alone sends the owner to the source.
    const { config, errors, rejected } = parsePhaseModelConfig({ build: { model: 'gpt-5.6-sol' } })
    expect(config).toEqual({})
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('gpt-5.6-sol')
    expect(errors[0]).toContain('sonnet')
    expect(isModelTier('gpt-5.6-sol')).toBe(false)
    // KEPT, not just dropped: the pane renders this struck through and names the
    // default it fell back to, so a choice that stopped working is visible rather
    // than silently reverted.
    expect(rejected['build']).toEqual({ model: 'gpt-5.6-sol' })
  })

  it('REJECTS a tier the phase cannot dispatch, and says which executor each is', () => {
    // The executor is a capability, not a preference. `sol` runs as a codex
    // subprocess and the rubric reviewer has only `agent({model})`, which resolves
    // against Claude Code's endpoint — so it is refused.
    const { config, errors, rejected } = parsePhaseModelConfig({ review_rubric: { model: 'sol' } })
    expect(config).toEqual({})
    expect(errors[0]).toContain('sol')
    expect(errors[0]).toContain('codex executor')
    // The message names the executor this step DOES dispatch on, so the owner can
    // tell "wrong family" from "not wired yet".
    expect(errors[0]).toContain('claude')
    // AND IT NEVER NAMES A SCRIPT. A tier's registered `wrapper` is the CROSS-MODEL
    // REVIEW wrapper; the build reaches the same codex tiers through
    // `trident/codex-build.sh`. Interpolating it told a BUILD-row owner their tier
    // "runs as a trident/codex-review.sh subprocess" — a true sentence about a phase
    // they were not configuring.
    for (const message of errors) {
      expect(message).not.toContain('codex-review.sh')
      expect(message).not.toContain('.sh')
    }
    // KEPT, not just dropped, so the pane can show it struck through.
    expect(rejected['review_rubric']).toEqual({ model: 'sol' })
    // And the mirror: the codex review lane cannot be pointed at a Claude tier.
    expect(parsePhaseModelConfig({ review_codex: { model: 'opus' } }).errors).toHaveLength(1)
    // Within one executor it is allowed — that is the whole feature.
    expect(parsePhaseModelConfig({ review_codex: { model: 'terra' } }).errors).toEqual([])
    expect(parsePhaseModelConfig({ review_kimi: { model: 'k3' } }).errors).toEqual([])
    // …but not ACROSS two CLI wrappers: `CODEX_REVIEW_MODEL=kimi-k3` is nonsense.
    expect(parsePhaseModelConfig({ review_codex: { model: 'k3' } }).errors).toHaveLength(1)
    // …and the build's SECOND executor is codex, not "any CLI": a Kimi tier on the
    // build row is still refused, because nothing dispatches it there.
    expect(parsePhaseModelConfig({ build: { model: 'k3' } }).errors).toHaveLength(1)
  })

  it('ACCEPTS a codex tier on the build row — the executor it is now wired to', () => {
    // The counterpart of the refusal above, and the reason this module grew
    // `alsoRunsOn`: the build dispatches to `trident/codex-build.sh` as well as to
    // `agent()`, so a GPT tier on that row is a choice the run can honour.
    for (const tier of ['sol', 'terra', 'luna']) {
      const { config, errors } = parsePhaseModelConfig({ build: { model: tier } })
      expect({ tier, errors }).toEqual({ tier, errors: [] })
      expect(config).toEqual({ build: { model: tier } })
    }
    // The Claude tiers still work on the same row — a second executor ADDS a choice,
    // it does not replace the default one.
    expect(parsePhaseModelConfig({ build: { model: 'sonnet' } }).errors).toEqual([])
  })

  it('ACCEPTS a codex tier on adversarial review but keeps rubric review on Claude', () => {
    expect(parsePhaseModelConfig({ review_adversarial: { model: 'terra' } }).errors).toEqual([])
    expect(parsePhaseModelConfig({ review_rubric: { model: 'terra' } }).errors).toHaveLength(1)
    expect(
      parsePhaseModelConfig({ review_adversarial: { model: 'terra', effort: 'max' } }).config,
    ).toEqual({ review_adversarial: { model: 'terra' } })
  })

  it('REFUSES a follower phase outright, and DROPS one that was already stored', () => {
    // `build_mechanical` has no row, so a value stored against it can never be seen or
    // cleared — and the workflow would have kept the `[mechanical]` build on whatever
    // it named while the pane showed the owner's codex tier on the only Build row
    // there is. Refused on the WRITE (an error names the key)…
    for (const entry of [{ model: 'sonnet' }, { model: 'terra' }, { effort: 'low' }, {}]) {
      const { config, errors } = parsePhaseModelConfig({ build_mechanical: entry })
      expect(config).toEqual({})
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("phase 'build_mechanical' is not settable")
      expect(errors[0]).toContain('build')
    }
    // …and DROPPED on the read, which is the migration: a blob persisted before this
    // rule loses the follower entry and keeps everything else. The read path is the
    // one that ignores `errors` and uses `config`.
    const stored = parsePhaseModelConfig({
      build: { model: 'terra' },
      build_mechanical: { model: 'sonnet', effort: 'low' },
    })
    expect(stored.config).toEqual({ build: { model: 'terra' } })
    // Never silently: the key is named, so the drop is visible to anything that reads
    // errors (the settings PUT 400s with exactly this text).
    expect(stored.errors).toHaveLength(1)
    // The rule is the DECLARATION, not a hard-coded key.
    for (const phase of TRIDENT_PHASES) {
      const { errors } = parsePhaseModelConfig({ [phase.key]: { model: 'opus' } })
      const settable = errors.every((e) => !e.includes('is not settable — it is the'))
      expect({ key: phase.key, settable }).toEqual({
        key: phase.key,
        settable: phase.follows === undefined,
      })
    }
  })

  it('REJECTS an effort on a phase whose executor has no effort control', () => {
    // A stored setting that no dispatch reads is the exact defect this module exists
    // to prevent — the owner sets it, nothing changes, the feature looks broken.
    const { config, errors } = parsePhaseModelConfig({ review_codex: { effort: 'max' } })
    expect(config).toEqual({})
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('not settable')
  })

  it('DROPS — never rejects — an effort paired with a codex model on the build row', () => {
    // `build` HAS an effort control, because its default executor reads one. Move the
    // row to the codex executor and that stops being true: a CLI picks its own
    // reasoning effort. The effort is a LEFTOVER from the executor the owner just
    // left, not a bad value, so it is dropped into `rejected` and the write SUCCEEDS.
    //
    // THE SAVE MUST NOT FAIL. An error here is a 400 on the whole PUT, which discards
    // every other row's pending edit and — for any owner who had ever touched the
    // build's effort — makes the codex tiers a selectable option that cannot be
    // selected. That is strictly worse than the greyed control this route removed.
    const { config, errors, rejected } = parsePhaseModelConfig({
      build: { model: 'sol', effort: 'max' },
    })
    expect(errors).toEqual([])
    expect(config).toEqual({ build: { model: 'sol' } })
    expect(rejected['build']).toEqual({ effort: 'max' })
    // Field ORDER must not change the answer: the model decides, and JSON has no
    // guaranteed order. Checked because the rule reads the two fields together.
    const reversed = parsePhaseModelConfig({ build: { effort: 'max', model: 'sol' } })
    expect(reversed.errors).toEqual([])
    expect(reversed.config).toEqual({ build: { model: 'sol' } })
    // …and the same effort with a Claude model is still perfectly fine.
    expect(parsePhaseModelConfig({ build: { model: 'sonnet', effort: 'max' } })).toEqual({
      config: { build: { model: 'sonnet', effort: 'max' } },
      errors: [],
      rejected: {},
    })
    // The drop is scoped to the pair. A phase that never had an effort control still
    // gets a loud error, because there the owner cannot even see a cell to explain it.
    expect(parsePhaseModelConfig({ review_codex: { effort: 'max' } }).errors).toHaveLength(1)
  })

  it('a codex build alongside other rows saves ALL of them, not none', () => {
    // The end-to-end shape of the bug: one settings save carries every row. When the
    // codex+effort pair was an error, moving the build to codex threw away the
    // synthesis change made in the same pass — and the owner was told only that the
    // build was wrong.
    const { config, errors } = parsePhaseModelConfig({
      build: { model: 'sol', effort: 'max' },
      synthesis: { effort: 'max' },
      review_rubric: { model: 'sonnet' },
    })
    expect(errors).toEqual([])
    expect(config).toEqual({
      build: { model: 'sol' },
      synthesis: { effort: 'max' },
      review_rubric: { model: 'sonnet' },
    })
  })

  it('drops an entry that sets nothing, so {} never persists as configuration', () => {
    const { config, errors } = parsePhaseModelConfig({ build: {} })
    expect(errors).toEqual([])
    expect(config).toEqual({})
  })

  it('treats null/undefined as "no configuration", not as an error', () => {
    expect(parsePhaseModelConfig(null)).toEqual({ config: {}, errors: [], rejected: {} })
    expect(parsePhaseModelConfig(undefined)).toEqual({ config: {}, errors: [], rejected: {} })
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
    // ONE KEY PER ROW, and a follower is not a row: `build_mechanical` dispatches
    // whatever `build` was set to, so shipping its own `sonnet` default would hand
    // every client a key it cannot render and a value the run contradicts.
    expect(Object.keys(defaults).sort()).toEqual(
      TRIDENT_PHASES.filter((p) => p.follows === undefined)
        .map((p) => p.key)
        .sort(),
    )
    expect(defaults['build_mechanical']).toBeUndefined()
    for (const phase of TRIDENT_PHASES) {
      if (phase.follows !== undefined) continue
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
    // nothing, silently producing the literal string 'opus' as a model id. Only the
    // AGENT-transport tiers live in this map: it is the workflow's per-role Claude
    // routing table, and a GPT id in it would be one `agent({model})` can't reach.
    for (const tier of ['fable', 'opus', 'sonnet', 'fast']) {
      expect(typeof models[tier]).toBe('string')
      expect(models[tier]!.length).toBeGreaterThan(0)
    }
  })

  it('threads the whole TIER REGISTRY, resolved, so a cross-model choice can land', async () => {
    const args = await makeInput(null)
    const tiers = args['modelTiers'] as Record<
      string,
      { model_id: string; transport: string; env_var: string | null; group: string }
    >
    // EVERY tier, or a tier the pane offers is one the dispatch cannot resolve.
    for (const tier of MODEL_TIERS) {
      expect(typeof tiers[tier]?.model_id).toBe('string')
      expect(tiers[tier]!.model_id.length).toBeGreaterThan(0)
      // The EXECUTOR travels too. Without it the workflow has to infer "can this
      // step take that tier" from transport+env_var matching, which is a proxy that
      // holds only while every phase has exactly one executor.
      expect([...TIER_GROUPS] as string[]).toContain(tiers[tier]!.group)
    }
    // And the transport travels with it — the difference between a model the
    // workflow can call and one it must shell out to.
    expect(tiers['opus']).toEqual({
      model_id: tiers['opus']!.model_id,
      transport: 'agent',
      env_var: null,
      group: 'claude',
    })
    expect(tiers['sol']).toEqual({
      model_id: 'gpt-5.6-sol',
      transport: 'cli',
      env_var: 'CODEX_REVIEW_MODEL',
      group: 'codex',
    })
    expect(tiers['k3']).toEqual({
      model_id: 'kimi-k3',
      transport: 'cli',
      env_var: 'KIMI_MODEL',
      group: 'kimi',
    })
  })
})
