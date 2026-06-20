/**
 * Self-contained Open-side copy of the v3 fixture schema + parser.
 *
 * Carved from `scripts/e2e/m2-walkthrough.ts` so the M2 integration tests
 * can validate v3 fixtures without depending on the (forbidden) scripts/
 * walkthrough harness. PURE: no SSH / browser / prod-box code, no scripts/
 * imports. Source of truth for the shape:
 * docs/plans/P2-v3-S4-fixture-harness-semantic-equivalence.md § 3.
 *
 * A v3 fixture is a phase-ordered onboarding walk: each phase carries a
 * target state ({phase_advanced_to, state_fields_populated,
 * auxiliary_facts_populated}) + a turn budget cap + ordered replies that
 * each carry optional semantic assertions.
 */

export type RouterDecisionFixtureAction = 'advance' | 'answer' | 'amend'

/** Subset of `RouterDecision` (from `onboarding/interview/llm-router.ts`)
 *  the fixture surfaces. */
export interface RouterDecisionFixture {
  action: RouterDecisionFixtureAction
  confidence?: number
  choice_value?: string | null
  freeform_text?: string | null
  response?: string | null
  state_delta?: Record<string, unknown> | null
}

export interface V3FixtureReply {
  kind: 'button' | 'freeform' | 'import' | 'wait'
  value?: string
  text?: string
  substrate?: 'chatgpt' | 'claude'
  fixture_zip?: string
  /** OPTIONAL — assert against the last `onboarding.router_decision`
   *  event's action. Skipped on `wait` replies + when the inspector does
   *  not implement `lastRouterAction` (production path). */
  assert_router_action?: RouterDecisionFixtureAction
  /** OPTIONAL — case-insensitive any-of substring assertion against the
   *  agent bubble emitted in response to this reply. */
  assert_body_contains_any?: ReadonlyArray<string>
  /**
   * OPTIONAL — sanity floor on bubble length.
   *
   * P2-v3 S5 (2026-05-19) — bumped default from 800 → 2000 to
   * accommodate live LLM rephrasing on phases with verbose canonical
   * bodies (the ChatGPT export instructions at `import_upload_pending`
   * are ~865 chars unrephrased, before any per-instance LLM expansion;
   * the v3 prod fixture's tangent-stretched bodies routinely land in
   * the 1200–1600 char range). 2000 is comfortably above the
   * largest live body observed during the S5 validation walk + below
   * the chat surface's natural breakpoint at ~3500 chars. Fixtures
   * that want a tighter sanity floor can still pin one explicitly.
   */
  assert_body_max_chars?: number
  /**
   * OPTIONAL — E2E credential-gated LLM-suggester assertion (brief:
   * e2e-synthetic-credential-injection). Same semantics as the v2
   * `personality_suggester_must_be_llm`: after this reply lands, gate on
   * the credential marker — SKIP when absent/0, assert
   * `personality_character_suggestions_source === 'llm'` (+ not the static
   * fallback set) when credentialed. Requires an inspector implementing
   * `llmCredentialed` + `phaseStateString`.
   */
  assert_personality_suggester_llm?: boolean
  /** OPTIONAL — fixture-side stub-router input consumed by the in-process
   *  test runner only; production browser walks ignore. */
  router_stub_response?: RouterDecisionFixture
}

export interface V3PhaseTargetState {
  /** Engine's persisted `phase` MUST end up in this set. */
  phase_advanced_to: ReadonlyArray<string>
  /** Required keys of `phase_state_json` that must be present + non-null
   *  after this phase exits. */
  state_fields_populated: ReadonlyArray<string>
  /** OPTIONAL — keys the router was expected to amend mid-flight. */
  auxiliary_facts_populated?: ReadonlyArray<string>
}

export interface V3FixturePhase {
  phase: string
  /** Hard turn cap. */
  turn_budget: number
  target_state: V3PhaseTargetState
  replies: ReadonlyArray<V3FixtureReply>
  expect_advance_to?: string
  terminal?: boolean
}

export interface V3Fixture {
  version: 3
  name: string
  description?: string
  /** Sum of every phase's `turn_budget`. */
  total_turn_budget?: number
  phases: ReadonlyArray<V3FixturePhase>
}

export function parseV3Fixture(input: string | unknown): V3Fixture {
  let parsed: unknown
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`v3 fixture: not valid JSON: ${msg}`)
    }
  } else {
    parsed = input
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('v3 fixture: must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (obj['version'] !== 3) {
    throw new Error(
      `v3 fixture: version must be the integer 3 (got ${JSON.stringify(obj['version'])})`,
    )
  }
  const name = typeof obj['name'] === 'string' ? (obj['name'] as string) : ''
  if (name.length === 0) {
    throw new Error('v3 fixture: name is required (non-empty string)')
  }
  const phasesRaw = obj['phases']
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) {
    throw new Error('v3 fixture: phases must be a non-empty array')
  }
  const phases: V3FixturePhase[] = phasesRaw.map((p, i) => parseV3FixturePhase(p, i))
  for (let i = 0; i < phases.length - 1; i++) {
    if (phases[i]!.terminal === true) {
      throw new Error(
        `v3 fixture: phases[${i}].terminal must only be set on the LAST phase (index ${i} of ${phases.length})`,
      )
    }
  }
  const out: V3Fixture = { version: 3, name, phases }
  if (typeof obj['description'] === 'string') {
    out.description = obj['description'] as string
  }
  if (obj['total_turn_budget'] !== undefined) {
    const n = Number(obj['total_turn_budget'])
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      throw new Error(
        'v3 fixture: total_turn_budget must be a positive integer when set',
      )
    }
    const sum = phases.reduce((acc, ph) => acc + ph.turn_budget, 0)
    if (sum > n) {
      throw new Error(
        `v3 fixture: total_turn_budget (${n}) is smaller than sum of per-phase turn_budget values (${sum})`,
      )
    }
    out.total_turn_budget = n
  }
  return out
}

function parseV3FixturePhase(raw: unknown, i: number): V3FixturePhase {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`v3 fixture: phases[${i}] must be an object`)
  }
  const pp = raw as Record<string, unknown>
  const phase = typeof pp['phase'] === 'string' ? (pp['phase'] as string) : ''
  if (phase.length === 0) {
    throw new Error(`v3 fixture: phases[${i}].phase is required (non-empty string)`)
  }
  const tbRaw = pp['turn_budget']
  const tb = Number(tbRaw)
  if (
    tbRaw === undefined ||
    !Number.isFinite(tb) ||
    !Number.isInteger(tb) ||
    tb < 1
  ) {
    throw new Error(`v3 fixture: phases[${i}].turn_budget must be a positive integer`)
  }
  const ts = parseV3TargetState(pp['target_state'], i)
  const repliesRaw = pp['replies']
  if (!Array.isArray(repliesRaw) || repliesRaw.length === 0) {
    throw new Error(`v3 fixture: phases[${i}].replies must be a non-empty array`)
  }
  const replies: V3FixtureReply[] = repliesRaw.map((r, j) =>
    parseV3FixtureReply(r, i, j),
  )
  const out: V3FixturePhase = { phase, turn_budget: tb, target_state: ts, replies }
  if (typeof pp['expect_advance_to'] === 'string') {
    out.expect_advance_to = pp['expect_advance_to'] as string
  }
  if (pp['terminal'] === true) {
    out.terminal = true
  }
  return out
}

function parseV3TargetState(raw: unknown, i: number): V3PhaseTargetState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`v3 fixture: phases[${i}].target_state must be an object`)
  }
  const ts = raw as Record<string, unknown>
  const pa = ts['phase_advanced_to']
  if (
    !Array.isArray(pa) ||
    pa.length === 0 ||
    !pa.every((x) => typeof x === 'string' && (x as string).length > 0)
  ) {
    throw new Error(
      `v3 fixture: phases[${i}].target_state.phase_advanced_to must be a non-empty array of non-empty strings`,
    )
  }
  const sf = ts['state_fields_populated']
  if (
    !Array.isArray(sf) ||
    !sf.every((x) => typeof x === 'string' && (x as string).length > 0)
  ) {
    throw new Error(
      `v3 fixture: phases[${i}].target_state.state_fields_populated must be an array of non-empty strings (may be empty)`,
    )
  }
  const out: V3PhaseTargetState = {
    phase_advanced_to: pa as ReadonlyArray<string>,
    state_fields_populated: sf as ReadonlyArray<string>,
  }
  const aux = ts['auxiliary_facts_populated']
  if (aux !== undefined) {
    if (
      !Array.isArray(aux) ||
      !aux.every((x) => typeof x === 'string' && (x as string).length > 0)
    ) {
      throw new Error(
        `v3 fixture: phases[${i}].target_state.auxiliary_facts_populated must be an array of non-empty strings when set`,
      )
    }
    out.auxiliary_facts_populated = aux as ReadonlyArray<string>
  }
  return out
}

function parseV3FixtureReply(
  raw: unknown,
  phase_index: number,
  reply_index: number,
): V3FixtureReply {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `v3 fixture: phases[${phase_index}].replies[${reply_index}] must be an object`,
    )
  }
  const r = raw as Record<string, unknown>
  const kind = r['kind']
  if (
    kind !== 'button' &&
    kind !== 'freeform' &&
    kind !== 'import' &&
    kind !== 'wait'
  ) {
    throw new Error(
      `v3 fixture: phases[${phase_index}].replies[${reply_index}].kind must be 'button', 'freeform', 'import', or 'wait'`,
    )
  }
  const out: V3FixtureReply = { kind }
  if (kind === 'button') {
    if (typeof r['value'] !== 'string' || (r['value'] as string).length === 0) {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].value is required for kind=button`,
      )
    }
    out.value = r['value'] as string
  } else if (kind === 'freeform') {
    if (typeof r['text'] !== 'string' || (r['text'] as string).length === 0) {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].text is required for kind=freeform`,
      )
    }
    out.text = r['text'] as string
  } else if (kind === 'import') {
    if (r['substrate'] !== 'chatgpt' && r['substrate'] !== 'claude') {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].substrate must be 'chatgpt' or 'claude'`,
      )
    }
    if (
      typeof r['fixture_zip'] !== 'string' ||
      (r['fixture_zip'] as string).length === 0
    ) {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].fixture_zip is required for kind=import`,
      )
    }
    out.substrate = r['substrate'] as 'chatgpt' | 'claude'
    out.fixture_zip = r['fixture_zip'] as string
  }
  if (r['assert_router_action'] !== undefined) {
    const ra = r['assert_router_action']
    if (ra !== 'advance' && ra !== 'answer' && ra !== 'amend') {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].assert_router_action must be 'advance', 'answer', or 'amend' when set`,
      )
    }
    out.assert_router_action = ra
  }
  if (r['assert_body_contains_any'] !== undefined) {
    const a = r['assert_body_contains_any']
    if (
      !Array.isArray(a) ||
      a.length === 0 ||
      !a.every((x) => typeof x === 'string' && (x as string).length > 0)
    ) {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].assert_body_contains_any must be a non-empty array of non-empty strings when set`,
      )
    }
    out.assert_body_contains_any = a as ReadonlyArray<string>
  }
  if (r['assert_body_max_chars'] !== undefined) {
    const n = Number(r['assert_body_max_chars'])
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].assert_body_max_chars must be a positive integer when set`,
      )
    }
    out.assert_body_max_chars = n
  }
  if (r['assert_personality_suggester_llm'] !== undefined) {
    if (typeof r['assert_personality_suggester_llm'] !== 'boolean') {
      throw new Error(
        `v3 fixture: phases[${phase_index}].replies[${reply_index}].assert_personality_suggester_llm must be a boolean when set`,
      )
    }
    out.assert_personality_suggester_llm = r['assert_personality_suggester_llm'] as boolean
  }
  if (r['router_stub_response'] !== undefined) {
    out.router_stub_response = parseRouterDecisionFixture(
      r['router_stub_response'],
      `phases[${phase_index}].replies[${reply_index}].router_stub_response`,
    )
  }
  return out
}

function parseRouterDecisionFixture(
  raw: unknown,
  path: string,
): RouterDecisionFixture {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`v3 fixture: ${path} must be an object`)
  }
  const r = raw as Record<string, unknown>
  const action = r['action']
  if (action !== 'advance' && action !== 'answer' && action !== 'amend') {
    throw new Error(
      `v3 fixture: ${path}.action must be 'advance' | 'answer' | 'amend'`,
    )
  }
  const out: RouterDecisionFixture = { action }
  if (r['confidence'] !== undefined) {
    const c = Number(r['confidence'])
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      throw new Error(`v3 fixture: ${path}.confidence must be in [0, 1] when set`)
    }
    out.confidence = c
  }
  if (r['choice_value'] !== undefined) {
    const cv = r['choice_value']
    if (cv !== null && (typeof cv !== 'string' || (cv as string).length === 0)) {
      throw new Error(
        `v3 fixture: ${path}.choice_value must be null or a non-empty string`,
      )
    }
    out.choice_value = cv as string | null
  }
  if (r['freeform_text'] !== undefined) {
    const ft = r['freeform_text']
    if (ft !== null && (typeof ft !== 'string' || (ft as string).length === 0)) {
      throw new Error(
        `v3 fixture: ${path}.freeform_text must be null or a non-empty string`,
      )
    }
    out.freeform_text = ft as string | null
  }
  if (r['response'] !== undefined) {
    const rp = r['response']
    if (rp !== null && (typeof rp !== 'string' || (rp as string).length === 0)) {
      throw new Error(
        `v3 fixture: ${path}.response must be null or a non-empty string`,
      )
    }
    out.response = rp as string | null
  }
  if (r['state_delta'] !== undefined) {
    const sd = r['state_delta']
    if (sd !== null && (typeof sd !== 'object' || Array.isArray(sd))) {
      throw new Error(
        `v3 fixture: ${path}.state_delta must be null or a plain object`,
      )
    }
    out.state_delta = sd as Record<string, unknown> | null
  }
  return out
}
