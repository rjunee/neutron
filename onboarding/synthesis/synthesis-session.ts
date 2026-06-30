/**
 * @neutronai/onboarding/synthesis — the ONE accumulating synthesis session
 * (Step 2). Authoritative design:
 * `docs/plans/onboarding-single-session-architecture-2026-06-17.md`.
 *
 * The heart of the rework. A SINGLE warm `claude` session (substrate factory
 * constructed exactly ONCE — `factory_constructions` MUST end at 1) reads the
 * pre-pass's organized history progressively, holding a running user-model in
 * its working context across passes. It NEVER emits `/clear` — clearing the
 * context between reads is the exact anti-pattern this rework removes (it
 * destroys the accumulating model). Each read pass routes its conversations
 * into per-project buckets; a final consolidation pass writes the
 * "here's what I know about you" summary + voice profile.
 *
 * Source-flexible per Ryan (2026-06-17): the same accumulating-session model
 * runs over an IMPORT (transcripts → batches) OR over INTERVIEW ANSWERS alone
 * (no transcripts to bucket) — the no-import path still stands up >= 1 project
 * for a minimal-but-real wow, no dead-end.
 *
 * Substrate discipline: every LLM call dispatches through the injected
 * `Substrate` (the CC-spawn interactive REPL in production — NEVER a direct
 * api.anthropic.com call, hard rule). The substrate is built NON-ephemeral +
 * NO `reset_context_per_turn` upstream so session-less `.start()` calls REUSE
 * the one warm REPL and accumulate context.
 */

import type { Substrate } from '../../runtime/substrate.ts'
import type { Event } from '../../runtime/events.ts'
import { getBestModel } from '../../runtime/models.ts'
import { extractJsonObject } from '../history-import/substrate-callers.ts'
import {
  SYNTHESIS_CEILING_MS_DEFAULT,
  SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT,
} from '../interview/llm-timeouts.ts'
import type { VoiceSignals } from '../history-import/types.ts'
import type { RawTranscriptStore } from './raw-store.ts'
import type {
  ConversationSignal,
  InterviewAnswer,
  PrepassResult,
  ProjectModel,
  ProjectSeed,
  SynthesisResult,
  UserModel,
} from './types.ts'

/**
 * The CONTEXT-RESET command the old per-chunk path wrote to the REPL between
 * chunks. The synthesis session must NEVER emit it — exported so the test
 * suite can assert no dispatched prompt contains it.
 */
export const FORBIDDEN_CONTEXT_RESET = '/clear'

/**
 * Hard cap on the number of TOP-LEVEL projects a synthesis run surfaces to the
 * owner (2026-06-18 wall-of-text fix). The live dogfood produced 24 verbose
 * micro-projects; the owner wanted ~6-10 crisp top-level companies. The read
 * prompts steer the LLM toward consolidation, and `finalizeProjects` enforces
 * this ceiling deterministically as the safety net so even an over-eager model
 * can't drop a wall of 24 on the owner. Keeps the best-supported projects (most
 * routed conversations first). Env-overridable for tuning without a redeploy.
 */
export const MAX_SYNTHESIS_PROJECTS = ((): number => {
  const raw = process.env['NEUTRON_MAX_SYNTHESIS_PROJECTS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 10
})()

/**
 * Max characters for a project's one-line overview/description (2026-06-18
 * wall-of-text fix). Synthesis proposed paragraph-long descriptions ("Acme
 * as a formulation dump"); the owner wanted a tight single line per project.
 * `finalizeProjects` truncates each overview to its first sentence, bounded by
 * this cap, so the projects_proposed presentation reads as a crisp list.
 */
export const MAX_PROJECT_OVERVIEW_CHARS = 140

export interface SynthesisSessionDeps {
  /**
   * Factory-once seam. EXACTLY ONE of `substrateFactory` / `substrate` is
   * supplied. When `substrateFactory` is set, the session calls it ONCE and
   * reuses the returned substrate for every read + consolidation pass — the
   * accumulating-session contract. Tests inject a counting factory and assert
   * it was constructed exactly once.
   */
  substrateFactory?: () => Substrate
  /** Pre-built accumulating substrate (alternative to the factory). */
  substrate?: Substrate
  /** Raw-transcript corpus (disk in prod) — read when assembling project seeds. */
  rawStore: RawTranscriptStore
  /** Model preference for the synthesis turns. Defaults to `[BEST_MODEL]`. */
  model_preference?: ReadonlyArray<string>
  /**
   * STREAM-ACTIVITY HEARTBEAT idle window (2026-06-18, owner-requested
   * wedge-detector). The PRIMARY wedge detector: a synthesis turn is abandoned
   * only when its substrate Event stream has been SILENT (no token / thinking /
   * status / tool / completion event) for this long. A turn that keeps streaming
   * stays alive regardless of total duration. Defaults to
   * `SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT` (env `NEUTRON_SYNTHESIS_IDLE_MS`).
   */
  idle_timeout_ms?: number
  /**
   * Absolute ceiling backstop (LONG synthesis tier). The FINAL bound behind the
   * idle-heartbeat — a turn is abandoned if it runs this long even while emitting
   * activity (a livelock guard). Generous by design (several minutes) so a
   * legitimately long but healthy streaming read pass is never killed by it; the
   * idle-heartbeat is what catches a real wedge fast. Defaults to
   * `SYNTHESIS_CEILING_MS_DEFAULT` (env `NEUTRON_SYNTHESIS_CEILING_MS`).
   */
  timeout_ms?: number
  /** Completion-token cap per turn. */
  max_tokens?: number
  /** Capture hook — every dispatched prompt (the `/clear`-absence assertion seam). */
  onDispatch?: (prompt: string) => void
  /** Failure sink. Default console.warn; never throws out of the run. */
  logFailure?: (stage: string, err: unknown) => void
  /**
   * Progress sink (2026-06-18). Called with `(done, total)` read-pass counts so
   * the import-job row drives a MOVING progress bar instead of stranding at
   * `pct=0.00 known=false` for the whole run (the dogfood symptom). Fired ONCE
   * up-front with `(0, total)` so `total` is known immediately, then after EACH
   * read pass with the running `done`. `total` excludes the consolidation pass —
   * it is the number of reading batches the bar advances across. Best-effort: a
   * throw is swallowed so a progress-sink failure never breaks synthesis.
   */
  onProgress?: (done: number, total: number) => void
}

/** Resolve the ONE substrate, counting constructions for the factory-once contract. */
function resolveSubstrate(deps: SynthesisSessionDeps): {
  substrate: Substrate
  constructions: number
} {
  if (deps.substrate !== undefined && deps.substrateFactory !== undefined) {
    throw new Error('runSynthesis: supply exactly one of `substrate` or `substrateFactory`')
  }
  if (deps.substrate !== undefined) return { substrate: deps.substrate, constructions: 0 }
  if (deps.substrateFactory !== undefined) {
    return { substrate: deps.substrateFactory(), constructions: 1 }
  }
  throw new Error('runSynthesis: one of `substrate` or `substrateFactory` is required')
}

/**
 * Run the accumulating synthesis over an IMPORTED history. Reads every
 * pre-pass batch through ONE session, routing conversations into per-project
 * buckets, then a final consolidation pass. Returns the user-model + the
 * per-project seed material the project repos are populated from.
 */
export async function runImportSynthesis(
  deps: SynthesisSessionDeps,
  input: { prepass: PrepassResult },
): Promise<SynthesisResult> {
  const { substrate, constructions } = resolveSubstrate(deps)
  const logFailure = deps.logFailure ?? defaultLogFailure
  const modelPref = resolveModelPref(deps)
  const idleMs = deps.idle_timeout_ms ?? SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT
  const ceilingMs = deps.timeout_ms ?? SYNTHESIS_CEILING_MS_DEFAULT
  const maxTokens = deps.max_tokens ?? 4096

  const signalsById = new Map<string, ConversationSignal>(
    input.prepass.conversations.map((c) => [c.conversation_id, c]),
  )
  const projects = new Map<string, ProjectModel>()
  const people = new Set<string>()
  // conversation_id -> set of project slugs
  const routing = new Map<string, Set<string>>()

  // Emit the total up-front so the progress bar knows its denominator from the
  // first tick (known=true, pct=0) rather than stranding at known=false.
  const totalBatches = input.prepass.reading_batches.length
  emitProgress(deps.onProgress, 0, totalBatches, logFailure)

  let batchesRead = 0
  let readPassesAttempted = 0
  let readPassesSucceeded = 0
  for (const batch of input.prepass.reading_batches) {
    const batchSignals = batch.conversation_ids
      .map((id) => signalsById.get(id))
      .filter((s): s is ConversationSignal => s !== undefined)
    if (batchSignals.length === 0) {
      // A skipped (empty) batch still counts toward the bar so it reaches 100%.
      batchesRead += 1
      emitProgress(deps.onProgress, batchesRead, totalBatches, logFailure)
      continue
    }
    const prompt = buildReadPrompt({
      passIndex: batch.index,
      totalPasses: input.prepass.reading_batches.length,
      runningProjects: [...projects.values()],
      runningPeople: [...people],
      batch: batchSignals,
    })
    readPassesAttempted += 1
    // RETRY-ONCE on timeout (2026-06-18): a timed-out pass abandon-poisons the
    // warm REPL, so the very next `substrate.start()` evicts + respawns a CLEAN
    // session — the retry therefore lands on fresh warmth. With the smaller
    // batches above a transient slow pass is rare, but one timeout must not zero
    // the whole synthesis. The accumulating model survives the respawn because
    // each read prompt re-states the running model explicitly (runningProjects /
    // runningPeople), not only the REPL's in-context memory.
    const { text } = await dispatchTurnWithRetry({
      substrate,
      prompt,
      modelPref,
      maxTokens,
      idleMs,
      ceilingMs,
      onDispatch: deps.onDispatch,
      logFailure,
      stage: `read_pass_${batch.index}`,
    })
    batchesRead += 1
    emitProgress(deps.onProgress, batchesRead, totalBatches, logFailure)
    if (text.length === 0) continue
    readPassesSucceeded += 1
    const parsed = parseReadResult(text)
    mergeProjects(projects, parsed.projects)
    for (const p of parsed.people) people.add(p)
    for (const r of parsed.routing) {
      const slugs = routing.get(r.conversation_id) ?? new Set<string>()
      for (const slug of r.project_slugs) {
        const canonical = slugify(slug)
        if (canonical.length > 0) slugs.add(canonical)
      }
      routing.set(r.conversation_id, slugs)
    }
  }

  // Attach routed conversation buckets to each project.
  for (const [convId, slugs] of routing) {
    for (const slug of slugs) {
      const project = projects.get(slug)
      if (project === undefined) continue
      if (!project.conversation_ids.includes(convId)) project.conversation_ids.push(convId)
    }
  }

  // Consolidate to TOP-LEVEL projects with crisp one-line overviews + a bounded
  // count (2026-06-18 wall-of-text fix). The read prompts steer the LLM toward
  // this; `finalizeProjects` enforces it deterministically as the safety net so
  // the projects_proposed presentation is ~6-10 tight rows, never a wall of 24.
  const finalizedProjects = finalizeProjects([...projects.values()])

  // Final consolidation pass — the "here's what I know about you" summary +
  // voice profile, over the SAME accumulating session. Pass the finalized
  // (trimmed, one-line) projects so the summary reflects the surfaced set.
  const consolidation = await consolidate({
    substrate,
    modelPref,
    maxTokens,
    idleMs,
    ceilingMs,
    onDispatch: deps.onDispatch,
    logFailure,
    projects: finalizedProjects,
    people: [...people],
    source: 'import',
  })

  const userModel: UserModel = {
    summary: consolidation.summary,
    projects: finalizedProjects,
    people: [...people],
    open_threads: consolidation.open_threads,
    tasks: consolidation.tasks,
    style: consolidation.style,
  }

  return {
    source: 'import',
    user_model: userModel,
    project_seeds: toSeeds(finalizedProjects),
    batches_read: batchesRead,
    read_passes_attempted: readPassesAttempted,
    read_passes_succeeded: readPassesSucceeded,
    factory_constructions: constructions,
  }
}

/**
 * No-import path. Run the SAME accumulating session over interview answers
 * alone — no transcripts to bucket — and stand up >= 1 project from what the
 * user described (a minimal-but-real wow, never a dead-end).
 */
export async function runInterviewOnlySynthesis(
  deps: SynthesisSessionDeps,
  input: { answers: ReadonlyArray<InterviewAnswer> },
): Promise<SynthesisResult> {
  const { substrate, constructions } = resolveSubstrate(deps)
  const logFailure = deps.logFailure ?? defaultLogFailure
  const modelPref = resolveModelPref(deps)
  const idleMs = deps.idle_timeout_ms ?? SYNTHESIS_IDLE_TIMEOUT_MS_DEFAULT
  const ceilingMs = deps.timeout_ms ?? SYNTHESIS_CEILING_MS_DEFAULT
  const maxTokens = deps.max_tokens ?? 4096

  const prompt = buildInterviewOnlyPrompt(input.answers)
  const { text } = await dispatchTurnWithRetry({
    substrate,
    prompt,
    modelPref,
    maxTokens,
    idleMs,
    ceilingMs,
    onDispatch: deps.onDispatch,
    logFailure,
    stage: 'interview_only',
  })
  const parsed = text.length > 0 ? parseInterviewOnlyResult(text) : emptyInterviewResult()

  // Guarantee >= 1 project — the no-dead-end contract. When the model
  // surfaced none (timeout / empty / refusal), synthesize one deterministically
  // from the answers so the owner still lands in a real, pre-populated project.
  let projects = parsed.projects
  if (projects.length === 0) {
    const fallback = fallbackProjectFromAnswers(input.answers)
    if (fallback !== null) projects = [fallback]
  }
  // Same top-level consolidation + one-line-overview + count cap as the import
  // path (2026-06-18 wall-of-text fix), so the no-import wow is just as crisp.
  projects = finalizeProjects(projects)

  const userModel: UserModel = {
    summary: parsed.summary.length > 0 ? parsed.summary : fallbackSummary(input.answers),
    projects,
    people: parsed.people,
    open_threads: parsed.open_threads,
    tasks: parsed.tasks,
    style: parsed.style,
  }

  return {
    source: 'interview',
    user_model: userModel,
    project_seeds: toSeeds(projects),
    batches_read: 0,
    // Interview-only has no read passes (a single synth turn) and ALWAYS yields
    // >= 1 project via the deterministic fallback, so it is never the "empty
    // wow" failure case — report 0/0.
    read_passes_attempted: 0,
    read_passes_succeeded: 0,
    factory_constructions: constructions,
  }
}

// ── Prompt construction ─────────────────────────────────────────────────────

interface ReadPromptInput {
  passIndex: number
  totalPasses: number
  runningProjects: ReadonlyArray<ProjectModel>
  runningPeople: ReadonlyArray<string>
  batch: ReadonlyArray<ConversationSignal>
}

function buildReadPrompt(input: ReadPromptInput): string {
  const runningProjectsJson = JSON.stringify(
    input.runningProjects.map((p) => ({ slug: p.slug, name: p.name, status: p.status })),
  )
  const convLines = input.batch
    .map((s) => {
      const date = s.created_at !== null ? new Date(s.created_at).toISOString().slice(0, 10) : 'undated'
      const terms = s.top_terms.join(', ')
      return `- id=${s.conversation_id} | ${date} | title="${s.title}" | terms=[${terms}] | "${s.snippet}"`
    })
    .join('\n')
  return [
    'You are building a model of a new Neutron owner from their AI chat history.',
    `This is read pass ${input.passIndex + 1} of ${input.totalPasses}. You are the SAME session`,
    'across every pass: keep ACCUMULATING the model you have built so far. Do NOT reset or start over.',
    '',
    'Running model so far (projects you have already named):',
    runningProjectsJson,
    `People so far: ${input.runningPeople.join(', ') || '(none yet)'}`,
    '',
    'New conversations in this pass (id | date | title | terms | first-message snippet):',
    convLines,
    '',
    'Update the model. A "project" is a TOP-LEVEL company, product, or recurring initiative',
    `(e.g. Acme, Globex, Initech, Umbrella) — NOT an individual feature, document, errand, or`,
    'sub-task. Fold sub-efforts into their parent top-level project (e.g. "Acme Photo" +',
    '"Acme Fragrance" -> "Acme"). Strongly prefer REUSING or MERGING into an existing',
    `slug over creating a new one; create a new project only for a genuinely distinct top-level`,
    `effort. Aim for a SMALL set of top-level projects across the WHOLE history (target ~6-10, never`,
    `more than ${MAX_SYNTHESIS_PROJECTS}). A conversation may map to more than one project, or to none`,
    '(omit it). The "overview" MUST be ONE crisp sentence (roughly <=20 words) — no paragraphs, no',
    'lists, no wall of text. Return STRICT JSON only, no prose:',
    '{',
    '  "projects": [{"slug": "kebab-case", "name": "...", "status": "short phrase", "overview": "ONE crisp sentence", "open_threads": ["..."]}],',
    '  "people": ["Full Name", "..."],',
    '  "routing": [{"conversation_id": "<id>", "project_slugs": ["<slug>"]}]',
    '}',
  ].join('\n')
}

function buildInterviewOnlyPrompt(answers: ReadonlyArray<InterviewAnswer>): string {
  const qa = answers
    .map((a) => `Q: ${a.prompt}\nA: ${a.answer}`)
    .join('\n\n')
  return [
    'A new Neutron owner answered onboarding questions. No chat history was imported, so build the',
    'model from their ANSWERS alone. Stand up AT LEAST ONE real project from what they described —',
    'never leave them with zero projects.',
    '',
    'A "project" is a TOP-LEVEL company, product, or recurring initiative — NOT an individual feature',
    `or sub-task. Fold sub-efforts into their parent. Keep the list SMALL (target ~6-10, never more`,
    `than ${MAX_SYNTHESIS_PROJECTS}). Each "overview" MUST be ONE crisp sentence (roughly <=20 words) —`,
    'no paragraphs, no lists, no wall of text.',
    '',
    'Answers:',
    qa,
    '',
    'Return STRICT JSON only, no prose:',
    '{',
    '  "projects": [{"slug": "kebab-case", "name": "...", "status": "short phrase", "overview": "ONE crisp sentence", "open_threads": ["..."]}],',
    '  "people": ["Full Name", "..."],',
    '  "summary": "2-4 sentence here-is-what-I-know-about-you",',
    '  "style": {"tone": "terse|expansive|neutral", "verbosity": "low|medium|high", "structure_pref": "bullets|prose|mixed"},',
    '  "tasks": ["..."],',
    '  "open_threads": ["..."]',
    '}',
    'At least one project is REQUIRED.',
  ].join('\n')
}

interface ConsolidateInput {
  substrate: Substrate
  modelPref: ReadonlyArray<string>
  maxTokens: number
  idleMs: number
  ceilingMs: number
  onDispatch: ((prompt: string) => void) | undefined
  logFailure: (stage: string, err: unknown) => void
  projects: ReadonlyArray<ProjectModel>
  people: ReadonlyArray<string>
  source: 'import'
}

interface ConsolidationResult {
  summary: string
  style: VoiceSignals
  tasks: string[]
  open_threads: string[]
}

async function consolidate(input: ConsolidateInput): Promise<ConsolidationResult> {
  const projectsJson = JSON.stringify(
    input.projects.map((p) => ({ name: p.name, status: p.status, overview: p.overview })),
  )
  const prompt = [
    'You have read the owner\'s entire history across every pass. Here is the accumulated model.',
    `Projects: ${projectsJson}`,
    `People: ${input.people.join(', ') || '(none)'}`,
    '',
    'Write the "here\'s what I know about you" summary and a voice profile. Return STRICT JSON only:',
    '{',
    '  "summary": "2-4 sentences, second person",',
    '  "style": {"tone": "terse|expansive|neutral", "verbosity": "low|medium|high", "structure_pref": "bullets|prose|mixed"},',
    '  "tasks": ["concrete open task", "..."],',
    '  "open_threads": ["..."]',
    '}',
  ].join('\n')
  const { text } = await dispatchTurnWithRetry({
    substrate: input.substrate,
    prompt,
    modelPref: input.modelPref,
    maxTokens: input.maxTokens,
    idleMs: input.idleMs,
    ceilingMs: input.ceilingMs,
    onDispatch: input.onDispatch,
    logFailure: input.logFailure,
    stage: 'consolidate',
  })
  if (text.length === 0) {
    return { summary: deriveSummary(input.projects, input.people), style: {}, tasks: [], open_threads: [] }
  }
  const obj = asRecord(extractJsonObject(text))
  const summary = strField(obj, 'summary')
  return {
    summary: summary.length > 0 ? summary : deriveSummary(input.projects, input.people),
    style: parseVoice(obj['style']),
    tasks: strArray(obj['tasks']),
    open_threads: strArray(obj['open_threads']),
  }
}

/** Fire the progress sink, swallowing any throw (progress is best-effort). */
function emitProgress(
  onProgress: ((done: number, total: number) => void) | undefined,
  done: number,
  total: number,
  logFailure: (stage: string, err: unknown) => void,
): void {
  if (onProgress === undefined) return
  try {
    onProgress(done, total)
  } catch (err) {
    logFailure('progress', err)
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

interface DispatchInput {
  substrate: Substrate
  prompt: string
  modelPref: ReadonlyArray<string>
  maxTokens: number
  /** Heartbeat idle-silence window — abort when NO stream event for this long. */
  idleMs: number
  /** Absolute ceiling backstop — abort if the turn runs this long regardless. */
  ceilingMs: number
  onDispatch: ((prompt: string) => void) | undefined
  logFailure: (stage: string, err: unknown) => void
  stage: string
}

/** Outcome of one dispatched turn. `timedOut` is true ONLY when the turn was
 *  abandoned by the wedge detector (idle-silence OR the absolute ceiling) before
 *  it completed — so the caller knows it can retry on a freshly respawned warm
 *  session. A plain empty/errored completion is `timedOut:false` (deterministic —
 *  retrying buys nothing). */
interface DispatchOutcome {
  text: string
  timedOut: boolean
}

/**
 * Run one turn on the (reused) substrate, draining assistant tokens under the
 * STREAM-ACTIVITY HEARTBEAT wedge-detector (2026-06-18, owner-requested). The
 * turn is abandoned ONLY when its Event stream goes SILENT for `idleMs` (the
 * primary detector) or runs past `ceilingMs` (the generous backstop) — a turn
 * that keeps streaming tokens/thinking/tool-calls stays alive no matter how long
 * it legitimately runs. Returns `{ text: '', timedOut }` on wedge / error / empty
 * completion so a single bad pass degrades to "no new info this pass" instead of
 * throwing out of the whole synthesis. The session is NEVER `/clear`'d between
 * turns.
 */
async function dispatchTurn(input: DispatchInput): Promise<DispatchOutcome> {
  // Defensive: this code path must never write the context-reset command.
  if (input.prompt.includes(FORBIDDEN_CONTEXT_RESET)) {
    input.logFailure(input.stage, new Error('refusing to dispatch a prompt containing /clear'))
    return { text: '', timedOut: false }
  }
  input.onDispatch?.(input.prompt)
  let handle: {
    events: AsyncIterable<Event>
    cancel: () => Promise<void>
    isAlive?: () => boolean
  }
  try {
    handle = input.substrate.start({
      prompt: input.prompt,
      tools: [],
      model_preference: [...input.modelPref],
      max_tokens: input.maxTokens,
    })
  } catch (err) {
    input.logFailure(input.stage, err)
    return { text: '', timedOut: false }
  }
  // CHILD-LIVENESS probe (2026-06-18 false-wedge fix). The persistent-REPL
  // substrate's handle additionally exposes `isAlive()` (a superset of the locked
  // SessionHandle contract — read structurally so any substrate works). When the
  // idle window expires on a SILENT turn, the drain consults this: a still-alive
  // child means the pass is reading + thinking (not hung), so it is NOT wedged;
  // only a dead/exited child trips the idle wedge. Belt-and-suspenders with the
  // substrate's liveness keepalive (which already keeps the idle timer from firing
  // while the child is alive). Absent on stateless test substrates → undefined →
  // the drain falls back to pure stream-event idle detection.
  const isAlive =
    typeof (handle as { isAlive?: unknown }).isAlive === 'function'
      ? (handle as { isAlive: () => boolean }).isAlive
      : undefined
  const result = await drainWithHeartbeat(handle.events, {
    idleMs: input.idleMs,
    ceilingMs: input.ceilingMs,
    ...(isAlive !== undefined ? { isAlive } : {}),
  })
  if (result.reason === 'idle' || result.reason === 'ceiling') {
    input.logFailure(
      input.stage,
      new Error(
        result.reason === 'idle'
          ? `synthesis turn wedged: no stream activity for ${input.idleMs}ms (idle-heartbeat)`
          : `synthesis turn hit the absolute ceiling of ${input.ceilingMs}ms`,
      ),
    )
    // Cancel so the substrate ABANDON-POISONS this warm session — the NEXT
    // `start()` then respawns a clean REPL, which is exactly what makes the
    // retry (below) land on fresh warmth rather than the wedged child.
    try {
      await handle.cancel()
    } catch {
      /* best-effort */
    }
    return { text: '', timedOut: true }
  }
  if (result.reason === 'error') {
    input.logFailure(input.stage, result.error)
    return { text: '', timedOut: false }
  }
  return { text: result.text, timedOut: false }
}

/**
 * Dispatch a synthesis turn, retrying ONCE if the first attempt is abandoned by
 * the wedge detector (2026-06-18 synthesis-completes fix). The first abandon
 * poisons the warm REPL, so the retry's `substrate.start()` evicts the poisoned
 * session + respawns a CLEAN one — a single transient slow/wedged pass therefore
 * can't zero the whole synthesis. A non-timeout empty/error is NOT retried
 * (deterministic).
 */
async function dispatchTurnWithRetry(input: DispatchInput): Promise<DispatchOutcome> {
  const first = await dispatchTurn(input)
  if (!first.timedOut || first.text.length > 0) return first
  input.logFailure(
    input.stage,
    new Error('synthesis turn wedged; retrying once on a freshly respawned warm session'),
  )
  return dispatchTurn({ ...input, stage: `${input.stage}_retry` })
}

/** Why `drainWithHeartbeat` stopped: clean completion, idle-silence wedge, the
 *  absolute-ceiling backstop, or a substrate error event. */
type DrainReason = 'done' | 'idle' | 'ceiling' | 'error'

interface DrainResult {
  /** Accumulated assistant token text (only meaningful when reason==='done'). */
  text: string
  reason: DrainReason
  /** Set only when reason==='error'. */
  error?: unknown
}

/**
 * Drain the substrate Event stream under a STREAM-ACTIVITY HEARTBEAT (the
 * owner-requested wedge detector). Manually pulls events and races each pull
 * against TWO timers:
 *
 *   - a per-iteration IDLE timer (`idleMs`) recreated on EVERY loop turn, so any
 *     event — token, thinking, status, tool_call/result, completion — RESETS the
 *     idle window. A turn that keeps streaming therefore never trips it; a turn
 *     that goes silent (zero events) for `idleMs` does. This is the primary
 *     detector: it distinguishes "wedged (emitting nothing)" from "legitimately
 *     long (still streaming)", which a fixed total cap cannot.
 *   - a single ABSOLUTE CEILING timer (`ceilingMs`) spanning the whole drain, the
 *     generous final backstop against a livelock that dodges the idle window
 *     forever.
 *
 * CHILD-LIVENESS (2026-06-18 false-wedge fix): when the idle window expires, the
 * drain consults the optional `opts.isAlive` probe BEFORE declaring a wedge. A
 * synthesis read pass reads + thinks SILENTLY (zero stream events) before its
 * first token; on a loaded box that silence can exceed the idle window, which
 * pure stream-event detection misreads as a wedge (the live failure: 100 % of
 * read passes false-wedged). If `isAlive()` reports the substrate's child still
 * running, the expiry is LIVENESS not a wedge — reset the window and keep the SAME
 * pending pull. Only when the child is GONE (or no probe is supplied) does an idle
 * expiry wedge. A true hang (child exited) still trips fast: `isAlive()` returns
 * false → idle wedge, and the substrate's `onDeath` error event returns even
 * sooner. The absolute ceiling still bounds a live-but-livelocked child.
 *
 * Returns `reason:'done'` with the accumulated token text on clean completion,
 * `reason:'idle'`/`reason:'ceiling'` when a timer fired first (the caller cancels
 * + may retry), or `reason:'error'` on a substrate error event. Exported for the
 * direct drain-level unit tests.
 */
export async function drainWithHeartbeat(
  events: AsyncIterable<Event>,
  opts: { idleMs: number; ceilingMs: number; isAlive?: () => boolean },
): Promise<DrainResult> {
  const iter = events[Symbol.asyncIterator]()
  let text = ''
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null
  const ceiling = new Promise<'__ceiling__'>((resolve) => {
    ceilingTimer = setTimeout(() => resolve('__ceiling__'), opts.ceilingMs)
  })
  // Exactly one pending pull at a time; a fresh idle timer per iteration is what
  // makes every event reset idle-silence.
  let nextP: Promise<IteratorResult<Event>> = iter.next()
  try {
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const idle = new Promise<'__idle__'>((resolve) => {
        idleTimer = setTimeout(() => resolve('__idle__'), opts.idleMs)
      })
      let res: IteratorResult<Event> | '__idle__' | '__ceiling__'
      try {
        res = await Promise.race([nextP, idle, ceiling])
      } finally {
        if (idleTimer !== null) clearTimeout(idleTimer)
      }
      if (res === '__idle__') {
        // The idle window expired with no stream event. Distinguish a silently-
        // reading-but-ALIVE turn (time-to-first-token on the synthesis read path)
        // from a genuine hang: if the substrate reports its child still running,
        // this is LIVENESS, not a wedge — recreate the idle timer next iteration
        // and keep the SAME pending pull. Only when the child is gone (or no probe
        // is supplied) do we declare the turn wedged. The absolute ceiling still
        // bounds a live-but-livelocked child that never streams.
        if (opts.isAlive?.() === true) continue
        void Promise.resolve(nextP).catch(() => undefined)
        return { text: '', reason: 'idle' }
      }
      if (res === '__ceiling__') {
        // Abandon the in-flight pull; swallow its eventual settle so a late
        // resolve/reject (after the caller cancels) is never an unhandled
        // rejection. The caller's `handle.cancel()` propagates real cancellation.
        void Promise.resolve(nextP).catch(() => undefined)
        return { text: '', reason: 'ceiling' }
      }
      if (res.done === true) return { text, reason: 'done' }
      const ev = res.value
      if (ev.kind === 'token') {
        text += ev.text
      } else if (ev.kind === 'error') {
        return { text: '', reason: 'error', error: new Error(`synthesis substrate error: ${ev.message}`) }
      }
      // completion / thinking / status / tool_* contribute no text but ARE
      // heartbeats — the next loop iteration's fresh idle timer covers them.
      nextP = iter.next()
    }
  } finally {
    if (ceilingTimer !== null) clearTimeout(ceilingTimer)
  }
}

// ── Parsing + merge ─────────────────────────────────────────────────────────

interface ParsedRead {
  projects: ProjectModel[]
  people: string[]
  routing: Array<{ conversation_id: string; project_slugs: string[] }>
}

function parseReadResult(text: string): ParsedRead {
  const obj = asRecord(extractJsonObject(text))
  return {
    projects: parseProjects(obj['projects']),
    people: strArray(obj['people']),
    routing: parseRouting(obj['routing']),
  }
}

interface ParsedInterview {
  projects: ProjectModel[]
  people: string[]
  summary: string
  style: VoiceSignals
  tasks: string[]
  open_threads: string[]
}

function parseInterviewOnlyResult(text: string): ParsedInterview {
  const obj = asRecord(extractJsonObject(text))
  return {
    projects: parseProjects(obj['projects']),
    people: strArray(obj['people']),
    summary: strField(obj, 'summary'),
    style: parseVoice(obj['style']),
    tasks: strArray(obj['tasks']),
    open_threads: strArray(obj['open_threads']),
  }
}

function emptyInterviewResult(): ParsedInterview {
  return { projects: [], people: [], summary: '', style: {}, tasks: [], open_threads: [] }
}

function parseProjects(raw: unknown): ProjectModel[] {
  if (!Array.isArray(raw)) return []
  const out: ProjectModel[] = []
  for (const item of raw) {
    const obj = asRecord(item)
    const name = strField(obj, 'name')
    const slugRaw = strField(obj, 'slug')
    const slug = slugify(slugRaw.length > 0 ? slugRaw : name)
    if (slug.length === 0 || name.length === 0) continue
    out.push({
      slug,
      name,
      status: strField(obj, 'status'),
      overview: strField(obj, 'overview'),
      open_threads: strArray(obj['open_threads']),
      conversation_ids: [],
    })
  }
  return out
}

function parseRouting(raw: unknown): Array<{ conversation_id: string; project_slugs: string[] }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ conversation_id: string; project_slugs: string[] }> = []
  for (const item of raw) {
    const obj = asRecord(item)
    const convId = strField(obj, 'conversation_id')
    if (convId.length === 0) continue
    out.push({ conversation_id: convId, project_slugs: strArray(obj['project_slugs']) })
  }
  return out
}

/** Merge parsed projects into the running map (union open_threads; keep latest non-empty prose). */
function mergeProjects(into: Map<string, ProjectModel>, incoming: ReadonlyArray<ProjectModel>): void {
  for (const p of incoming) {
    const existing = into.get(p.slug)
    if (existing === undefined) {
      into.set(p.slug, { ...p, open_threads: [...p.open_threads], conversation_ids: [...p.conversation_ids] })
      continue
    }
    if (p.name.length > 0) existing.name = p.name
    if (p.status.length > 0) existing.status = p.status
    if (p.overview.length > 0) existing.overview = p.overview
    for (const t of p.open_threads) {
      if (!existing.open_threads.includes(t)) existing.open_threads.push(t)
    }
  }
}

/**
 * Consolidate the running project set into the TOP-LEVEL list surfaced to the
 * owner (2026-06-18 wall-of-text fix). Deterministic safety net behind the
 * read-prompt steering:
 *
 *   1. Crush each `overview` to ONE crisp line — first sentence, bounded by
 *      `MAX_PROJECT_OVERVIEW_CHARS` — so no project carries a paragraph/list.
 *   2. Rank by support (most routed conversations first, then most open threads,
 *      then name for stable ties) and keep at most `MAX_SYNTHESIS_PROJECTS`, so
 *      an over-eager model can't drop a wall of 24 micro-projects on the owner.
 *
 * Ranking-then-truncating (rather than dropping arbitrary rows) keeps the
 * best-evidenced top-level projects; the read prompt is what does the real
 * semantic merging of sub-efforts into their parent.
 */
export function finalizeProjects(
  projects: ReadonlyArray<ProjectModel>,
  max: number = MAX_SYNTHESIS_PROJECTS,
): ProjectModel[] {
  const ranked = [...projects].sort((a, b) => {
    if (b.conversation_ids.length !== a.conversation_ids.length) {
      return b.conversation_ids.length - a.conversation_ids.length
    }
    if (b.open_threads.length !== a.open_threads.length) {
      return b.open_threads.length - a.open_threads.length
    }
    return a.name.localeCompare(b.name)
  })
  return ranked.slice(0, Math.max(1, max)).map((p) => ({
    ...p,
    overview: oneLineOverview(p.overview),
    open_threads: [...p.open_threads],
    conversation_ids: [...p.conversation_ids],
  }))
}

/**
 * Collapse a (possibly multi-paragraph) overview to a single crisp line: flatten
 * whitespace, take the first sentence, and hard-cap at `MAX_PROJECT_OVERVIEW_CHARS`.
 */
function oneLineOverview(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  const boundary = flat.search(/[.!?](\s|$)/)
  const sentence = boundary === -1 ? flat : flat.slice(0, boundary + 1)
  if (sentence.length <= MAX_PROJECT_OVERVIEW_CHARS) return sentence
  return `${sentence.slice(0, MAX_PROJECT_OVERVIEW_CHARS - 3).trimEnd()}...`
}

function toSeeds(projects: ReadonlyArray<ProjectModel>): ProjectSeed[] {
  return projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    status: p.status,
    overview: p.overview,
    open_threads: [...p.open_threads],
    conversation_ids: [...p.conversation_ids],
  }))
}

// ── Deterministic fallbacks (no-LLM safety nets) ────────────────────────────

function fallbackProjectFromAnswers(answers: ReadonlyArray<InterviewAnswer>): ProjectModel | null {
  const first = answers.find((a) => a.answer.trim().length > 0)
  if (first === undefined) return null
  const name = firstClause(first.answer, 60)
  const slug = slugify(name)
  if (slug.length === 0) return null
  return {
    slug,
    name,
    status: 'active',
    overview: first.answer.trim(),
    open_threads: [],
    conversation_ids: [],
  }
}

function fallbackSummary(answers: ReadonlyArray<InterviewAnswer>): string {
  const said = answers
    .map((a) => a.answer.trim())
    .filter((a) => a.length > 0)
    .slice(0, 3)
    .join(' ')
  return said.length > 0 ? `Here's what you told me: ${firstClause(said, 280)}` : 'Welcome to Neutron.'
}

function deriveSummary(projects: ReadonlyArray<ProjectModel>, people: ReadonlyArray<string>): string {
  const names = projects.map((p) => p.name).slice(0, 4)
  if (names.length === 0) return 'Welcome to Neutron.'
  const peopleClause = people.length > 0 ? ` Key people: ${people.slice(0, 4).join(', ')}.` : ''
  return `You're working across ${names.join(', ')}.${peopleClause}`
}

// ── Coercion helpers ────────────────────────────────────────────────────────

function resolveModelPref(deps: SynthesisSessionDeps): ReadonlyArray<string> {
  return deps.model_preference !== undefined && deps.model_preference.length > 0
    ? deps.model_preference
    : [getBestModel()]
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

function strArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim())
  }
  return out
}

function parseVoice(raw: unknown): VoiceSignals {
  const obj = asRecord(raw)
  const out: VoiceSignals = {}
  const tone = obj['tone']
  if (tone === 'terse' || tone === 'expansive' || tone === 'neutral') out.tone = tone
  const verbosity = obj['verbosity']
  if (verbosity === 'low' || verbosity === 'medium' || verbosity === 'high') out.verbosity = verbosity
  const structure = obj['structure_pref']
  if (structure === 'bullets' || structure === 'prose' || structure === 'mixed') {
    out.structure_pref = structure
  }
  const phrases = strArray(obj['signature_phrases'])
  if (phrases.length > 0) out.signature_phrases = phrases
  return out
}

/** kebab-case slug from arbitrary text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function firstClause(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  const boundary = flat.search(/[.!?,;:](\s|$)/)
  const clause = boundary === -1 ? flat : flat.slice(0, boundary)
  const trimmed = clause.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 3).trimEnd()}...`
}

function defaultLogFailure(stage: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[synthesis-session] ${stage}: ${err instanceof Error ? err.message : String(err)}`)
}
