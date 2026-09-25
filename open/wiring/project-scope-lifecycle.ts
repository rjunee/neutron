/**
 * open/wiring/project-scope-lifecycle.ts — the ONE explicit project-scope lifecycle
 * owner at the composer boundary (#1226).
 *
 * Every owner conversation is placed as its scope's single `Chat` (T1), and the
 * project-workspace manager refuses a second live Chat owner. The credential pool can
 * still choose another credential, which names a different warm REPL (`poolKeyFor`
 * folds `credential_identity`). This owner turns that re-key into a VERIFIED HANDOFF:
 * the old exact owner is retired through the pool's own authority
 * (`retirePersistentRepl`), and only once it is positively gone does the manager's
 * next Chat placement see an empty slot and create a fresh Chat in the same workspace.
 *
 * Authority and evidence:
 *   - The owner is read from the pool's exact-identity census parent reader
 *     (`resolveLiveProjectSessions`), filtered to the dispatch's EXACT conversation
 *     scope: null is General, the literal `general` project is its own scope, and a
 *     row with no recorded conversation scope is never an owner.
 *   - Awake evidence is READ-ONLY: the #1237 `liveChild` leases and the liveness
 *     census. An unresolved native child refuses; unknown liveness never licenses
 *     closure. Admission state is never written here.
 *   - Retirement is the pool's: it fences new dispatch on the old key, waits for the
 *     committed turn to leave, refuses an unresolved native child or an unverified
 *     survivor, refreshes the registry claim under lock and reports `retired` only
 *     after the child (on Herdr: the pane) is confirmed gone. Transcripts are kept.
 *
 * Nothing here kills by prefix, touches another scope or writes admission. A refusal
 * or unknown leaves the old Chat exactly as it was.
 *
 * SLEEP/WAKE (#1226 T3) is the same owner:
 *   - `awake(scope)` reads every awake condition READ-ONLY: each #1237 lease of the
 *     exact scope (conversation, queuedDispatch, build, approval, liveChild — a lease
 *     from a PREVIOUS boot still counts: restart expires nothing), the admission's
 *     unresolved native child, a pending approval attributed to the scope (one that
 *     cannot be attributed keeps EVERY scope awake), the liveness census (`busy`;
 *     ambiguous/unidentified/legacy-unknown/unknown, a thrown or unbound census are
 *     `unknown`) and recent owner foreground activity.
 *   - `sleep(scope)` retires an idle owned Chat: the manager's read-only sample must
 *     show this scope's own LIVE slot first (foreign/unverified refuses, and a sample
 *     that contradicts the pool's live owner is unknown, before anything is killed),
 *     then the pool's exact retirement runs in SLEEP mode (the conversation's registry
 *     row loses its pid/handle/claims but keeps its session id and gains the durable
 *     `asleep_at` pin, so the next spawn `--resume`s; transcripts are never touched),
 *     then the manager re-samples: the pane is positively gone. Pane-only: the
 *     workspace is never closed (no atomic server-side guard exists) and is left for
 *     lifecycle reconciliation.
 *   - ADMISSION IS STOPPED FIRST. Sleep and handoff are serialized per exact scope, so
 *     a conversation dispatch for the scope waits for a sleep in progress (and then
 *     wakes it) instead of racing it. The pool fences the key before it re-reads this
 *     owner's lease/approval evidence SYNCHRONOUSLY right before termination, so work
 *     admitted after the first read keeps the Chat. A sleep that does not retire leaves
 *     nothing scheduled: the pool's drain retry never retires an unverified sleep.
 *   - WAKE IS THE NEXT ADMITTED DISPATCH, not a new spawn path: a message reaches the
 *     live-chat substrate, which pins the asleep conversation's credential from the
 *     DURABLE registry row (`resumeCredentialFor`, while usable — process memory is
 *     never the pin, so a restart still resumes), `handoffChat` finds no owner and the
 *     spawn resumes the asleep row into a fresh Chat tab of the SAME workspace; due
 *     project work places a worker, and the manager reserves Chat with the inert
 *     placeholder until a real Chat replaces it (#1254 identity revalidation).
 *   - Restart adoption stays the boot path (`adoptLiveAgentRepls`): a survivor with a
 *     pane is adopted, never spawned over. Gateway restart is not a sleep event; idle
 *     timers are in-process and re-arm on the next settled turn.
 */
import { createLogger, type LogFields } from '@neutronai/logger'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type {
  ConversationLifecycle,
  ConversationOwner,
  ChatHandoffOutcome,
} from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import {
  persistentReplRetirementPhase,
  readmitRetiredPersistentRepl,
  retirePersistentRepl,
  type HelperRetirement,
  type SleepRetirement,
} from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import {
  readAsleepConversations,
  resolveLiveProjectSessions,
  type AsleepConversation,
  type ResolvedProjectSessions,
} from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import type { ChatInspection } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts'
import type { AdmissionReason } from '@neutronai/gateway/project-admission-store.ts'
import type { ProjectLivenessSurface } from './project-liveness.ts'

export type { ConversationOwner, ChatHandoffOutcome }

/** Why a scope is awake. The five lease reasons plus census `busy` and owner `foreground`. */
export type AwakeReason = AdmissionReason | 'busy' | 'foreground'

export type AwakeOutcome =
  | { status: 'idle' }
  | { status: 'awake'; reasons: AwakeReason[] }
  | { status: 'unknown'; reason: string }

export type SleepOutcome =
  | { status: 'retired'; sessionId: string; workspace: 'pane-retired' | 'left-for-reconciliation' }
  | { status: 'absent' }
  | { status: 'refused' | 'unknown'; reason: string }

/** The lifecycle surface the composition exposes. */
export interface ProjectScopeLifecycle extends ConversationLifecycle {
  /** Read-only awake evidence for the exact scope. */
  awake(scope: string | null): Promise<AwakeOutcome>
  /** Retire the scope's idle owned Chat, keeping its conversation resumable. */
  sleep(scope: string | null): Promise<SleepOutcome>
  /** Whether the scope has no live owner and a durable asleep conversation to resume. */
  isAsleep(scope: string | null): Promise<boolean>
  /** Arm (or re-arm) the scope's idle timer: on fire, `sleep`. */
  armIdle(scope: string | null): void
  /** Disarm the scope's idle timer (a dispatch is about to run). */
  disarmIdle(scope: string | null): void
  /** Stop every timer (composition teardown). */
  close(): void
}

export interface ProjectScopeLifecycleLog {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
}

export interface ProjectScopeLifecycleDeps {
  admission: Pick<ProjectAdmission, 'listLeases' | 'hasUnresolvedNativeChildForChat'>
  /** The pool's exact-identity parent reader (production default). */
  sessions?: (poolProjectIds: ReadonlyArray<string | undefined>) => Promise<ResolvedProjectSessions>
  /** The pool's exact-key retirement authority (production default). Sleep passes
   * {@link SleepRetirement} so the row stays resumable and the pool re-reads the
   * scope's evidence right before termination. */
  retire?: (sessionKey: string, sleep?: SleepRetirement) => Promise<HelperRetirement>
  /** The durable REPL registry (production: the instance's supervision registry). The
   * wake pin and `isAsleep` read the scope's asleep rows from it. */
  registryPath?: string
  /** Override of the durable asleep-row reader (tests). */
  asleepConversations?: (scope: string | null) => ReturnType<typeof readAsleepConversations>
  /** Pending tool approvals (read-only, SYNCHRONOUS: re-read right before a sleep's
   * termination), each with the topic it was raised in. `instanceGrant` marks an
   * INSTANCE capability grant ({@link isInstanceGrantApproval}), which holds no scope's work. */
  pendingApprovals?: () => ReadonlyArray<{ topicId: string | null; instanceGrant?: boolean }>
  /** A topic's conversation scope; undefined = cannot be attributed (keeps every scope awake). */
  topicScope?: (topicId: string | null) => { scope: string | null } | undefined
  /** The owner's last genuine turn in the scope (ms since epoch), or null. */
  foregroundMs?: (scope: string | null) => Promise<number | null> | number | null
  /** The shared manager's read-only Chat sample (on Herdr). */
  conversationTerminal?: { inspectChat?(scope: string | null): Promise<ChatInspection> }
  /** The scope's provider. With NO Claude owner, a Codex scope (`openai-codex`) has no exact
   * retirement authority, so sleep refuses it; a Claude owner is decided by its own kind. */
  providerFor?: (scope: string | null) => string
  /** Idle period before a settled scope sleeps; also the foreground window. 0 disables timers. */
  idleMs?: number
  now?: () => number
  /** Read-only phase of an exact key while its retirement drains. */
  phase?: (sessionKey: string) => Promise<'absent' | 'busy' | 'idle'>
  /** Lift a completed retirement's fence from the key the next Chat will use. */
  readmit?: (sessionKey: string) => boolean
  /** The liveness census, late-bound (built after the substrates); undefined = not yet. */
  liveness?: () => ProjectLivenessSurface | undefined
  log?: ProjectScopeLifecycleLog
  pollMs?: number
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Whether a pending approval grants an INSTANCE capability rather than holding a
 * project conversation's work (#1226): an approval raised in no topic at all, or one
 * of the instance grant kinds (a ritual's content/egress grant, a host deploy, an MCP
 * server install). The gateway decides these on the owner's tap whether or not any
 * Chat is awake, and no TTL sweep runs, so counting them would make one unanswered
 * prompt keep every scope awake forever. The kinds are passed in by the composer from
 * their owners' own name functions, so a rename cannot silently drift here.
 */
export function isInstanceGrantApproval(
  approval: { topicId: string | null; toolName: string },
  kinds: { exact: ReadonlyArray<string>; prefixes: ReadonlyArray<string> },
): boolean {
  if (approval.topicId === null) return true
  return kinds.exact.includes(approval.toolName) || kinds.prefixes.some(prefix => approval.toolName.startsWith(prefix))
}

export const DEFAULT_HANDOFF_POLL_MS = 500
export const DEFAULT_HANDOFF_WAIT_MS = 60_000
/** Default idle period before an owner conversation sleeps (#1226). */
export const PROJECT_SLEEP_IDLE_MS = 30 * 60_000

/** `NEUTRON_PROJECT_SLEEP_IDLE_MS` overrides the default; `0` disables idle sleep. */
export function projectSleepIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env['NEUTRON_PROJECT_SLEEP_IDLE_MS']
  if (raw === undefined || raw.trim() === '') return PROJECT_SLEEP_IDLE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : PROJECT_SLEEP_IDLE_MS
}

/** The pool names General `'general'` or leaves it absent; the literal project
 * `general` shares the pool value, so ownership is decided by conversation scope. */
function poolProjectIds(scope: string | null): ReadonlyArray<string | undefined> {
  return scope === null ? ['general', undefined] : [scope]
}

export function createProjectScopeLifecycle(deps: ProjectScopeLifecycleDeps): ProjectScopeLifecycle {
  const sessions = deps.sessions ?? resolveLiveProjectSessions
  const retire = deps.retire ?? ((key: string, sleepMode?: SleepRetirement) => retirePersistentRepl(key, undefined, sleepMode))
  const phase = deps.phase ?? persistentReplRetirementPhase
  const readmit = deps.readmit ?? readmitRetiredPersistentRepl
  const log = deps.log ?? createLogger('project-scope-lifecycle')
  const pollMs = deps.pollMs ?? DEFAULT_HANDOFF_POLL_MS
  const defaultWaitMs = deps.waitMs ?? DEFAULT_HANDOFF_WAIT_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  /**
   * ONE lifecycle actuation per exact scope at a time (null and the literal `general`
   * are different keys). A sleep holds it from its first evidence read to its last
   * re-sample, and a conversation dispatch's handoff waits behind it — so a message
   * arriving mid-sleep is admitted AFTER the sleep settles and wakes the conversation,
   * never racing its termination.
   */
  const scopeLocks = new Map<string | null, Promise<unknown>>()
  function withScope<T>(scope: string | null, fn: () => Promise<T>): Promise<T> {
    // The stored tail never rejects (it only orders the next caller); the caller
    // receives `run` itself, with fn's own outcome.
    const prior = scopeLocks.get(scope) ?? Promise.resolve()
    let tail: Promise<void> | undefined
    const run = (async () => {
      await prior
      try { return await fn() } finally {
        if (scopeLocks.get(scope) === tail) scopeLocks.delete(scope)
      }
    })()
    tail = run.then(() => undefined, () => undefined)
    scopeLocks.set(scope, tail)
    return run
  }

  async function ownerFor(scope: string | null): Promise<ConversationOwner> {
    const resolved = await sessions(poolProjectIds(scope))
    // Exact scope only: an undefined conversation scope is ambiguous for General and
    // is never an owner; the literal `general` project never answers for General.
    const owners = resolved.live.filter(row => row.options.conversationProjectId === scope)
    // A Chat spawn still in flight is an owner about to exist, never absence: two
    // concurrent cold dispatches must converge on ONE Chat, not race two credentials.
    const spawning = (resolved.pending ?? []).filter(row => row.options.conversationProjectId === scope)
    const count = owners.length + spawning.length
    if (count === 0) return { kind: 'none' }
    if (count > 1) {
      const credentialIds = [...new Set([...owners.map(row => row.options), ...spawning.map(row => row.options)]
        .map(options => options.credential_identity ?? '_nocred'))]
      const sessionKeys = [...owners, ...spawning].map(row => row.sessionKey)
      return { kind: 'ambiguous', count, credentialIds, sessionKeys }
    }
    if (owners.length === 0) {
      const spawn = spawning[0]!
      return { kind: 'owner', sessionKey: spawn.sessionKey, credentialId: spawn.options.credential_identity ?? '_nocred', sessionId: '', spawning: true }
    }
    const owner = owners[0]!
    const pane = owner.session.child.paneHandle
    return {
      kind: 'owner', sessionKey: owner.sessionKey,
      credentialId: owner.options.credential_identity ?? '_nocred', sessionId: owner.session.sessionId,
      ...(pane === undefined ? {} : { pane }),
    }
  }

  function unresolvedChild(scope: string | null): boolean {
    return deps.admission.listLeases('liveChild').some(lease => lease.scope.projectId === scope) ||
      deps.admission.hasUnresolvedNativeChildForChat(scope)
  }

  function handoffChat(
    scope: string | null,
    next: { sessionKey: string; credentialId: string },
    options: { waitMs?: number; keepResumable?: boolean } = {},
  ): Promise<ChatHandoffOutcome> {
    return withScope(scope, () => handoffOnce(scope, next, options))
  }

  /**
   * The census gate a handoff re-reads IMMEDIATELY before each retirement attempt,
   * after any wait. Every part must be positively idle: a busy verdict never masks
   * unknown children or shells (`combineVerdicts` makes busy beat unknown), and busy
   * descendants are never waited out by the pool, which only waits the parent turn.
   *   - `wait`: the parent turn (or a shell of the owner) is busy — look again later.
   *   - an outcome: refuse (native child work) or unknown (anything unproven).
   *   - undefined: licensed.
   */
  async function handoffCensusGate(scope: string | null, fields: LogFields): Promise<'wait' | ChatHandoffOutcome | undefined> {
    const surface = deps.liveness?.()
    // Unbound (composition still building): the pool's own exact authority stands alone.
    if (surface === undefined) return undefined
    let census: Awaited<ReturnType<ProjectLivenessSurface['census']>>
    try { census = await surface.census(scope, { excludePendingDispatch: true }) } catch (error) {
      const reason = `liveness census failed: ${error instanceof Error ? error.message : String(error)}`
      log.warn('chat_handoff_unknown', { ...fields, reason })
      return { status: 'unknown', reason }
    }
    const kind = census.parent.kind
    const unknown = (detail: string): ChatHandoffOutcome => {
      const reason = `liveness unknown (${detail}): ${census.reasons.join('; ')}`
      log.warn('chat_handoff_unknown', { ...fields, reason })
      return { status: 'unknown', reason }
    }
    if (kind === 'ambiguous' || kind === 'unidentified' || kind === 'legacy-unknown') return unknown(kind)
    if (census.verdict === 'unknown') return unknown(`${kind}, verdict unknown`)
    if (census.children === 'unknown' || census.shells === 'unknown' || census.parentTurn === 'unknown') {
      return unknown(`${kind}: parent turn ${census.parentTurn}, children ${census.children}, shells ${census.shells}`)
    }
    if (census.children === 'busy') {
      log.warn('chat_handoff_refused', { ...fields, reason: 'native child work in progress' })
      return { status: 'refused', reason: 'native child work in progress' }
    }
    if (census.parentTurn === 'busy' || census.shells === 'busy') return 'wait'
    if (census.children !== 'idle' || census.shells !== 'idle' || census.parentTurn !== 'idle') {
      return unknown(`${kind}: parent turn ${String(census.parentTurn)}, children ${String(census.children)}, shells ${String(census.shells)}`)
    }
    return undefined
  }

  async function handoffOnce(
    scope: string | null,
    next: { sessionKey: string; credentialId: string },
    options: { waitMs?: number; keepResumable?: boolean },
  ): Promise<ChatHandoffOutcome> {
    const fields = { scope, to_credential: next.credentialId }
    const waitMs = options.waitMs ?? defaultWaitMs
    const deadline = Date.now() + waitMs
    const pause = () => sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    const owner = await ownerFor(scope)
    if (owner.kind === 'ambiguous') {
      log.warn('chat_handoff_unknown', { ...fields, reason: 'ambiguous owner', count: owner.count })
      return { status: 'unknown', reason: `ambiguous Chat owner: ${owner.count} live sessions` }
    }
    if (owner.kind === 'none') {
      // No Claude owner. The manager's Chat slot must not hold a live owner of ANOTHER
      // kind (a durable Codex native owner after a live provider switch): the manager
      // would refuse the placement, and this owner has no exact authority to retire it.
      const held = await deps.conversationTerminal?.inspectChat?.(scope)
      if (held?.status === 'live') {
        const reason = 'the scope Chat is held by a live owner the Claude pool does not own (a Codex native owner ' +
          'after a provider switch, or an unadopted survivor); nothing was closed. Recovery: switch the project back ' +
          'to Codex to continue that conversation, or end that owner session before switching to Claude'
        log.warn('chat_handoff_refused', { ...fields, reason: 'Chat held by a non-Claude owner' })
        return { status: 'refused', reason }
      }
      // Nothing to retire. A key whose earlier retirement completed may serve again.
      if (!readmit(next.sessionKey)) {
        log.warn('chat_handoff_busy', { ...fields, reason: 'next key still retiring' })
        return { status: 'busy', reason: 'the next Chat session is still retiring' }
      }
      return { status: 'ready' }
    }
    if (owner.sessionKey === next.sessionKey && readmit(next.sessionKey)) return { status: 'ready' }
    if (owner.spawning === true) {
      // A spawn in flight on ANOTHER key is a Chat about to exist (a concurrent cold
      // dispatch picked another credential): never absence, and never retired before
      // it has served. This dispatch spawns nothing; its retry pins that owner's
      // credential (the same key is joined by the pool, above).
      log.warn('chat_handoff_busy', { ...fields, reason: 'a Chat spawn is still in flight' })
      return { status: 'busy', reason: 'a Chat spawn for the scope is still in flight' }
    }
    const from = { ...fields, from_credential: owner.credentialId, session_id: owner.sessionId }
    const oldKey = owner.sessionKey
    const refused = (): ChatHandoffOutcome => {
      log.warn('chat_handoff_refused', { ...from, reason: 'pool refused retirement' })
      return { status: 'refused', reason: 'the pool refused to retire the old Chat owner (ownership or exit not confirmed)' }
    }

    // RE-VERIFIED retirement: wait the owner's turn out HERE (never through the pool's
    // own drain retry), re-read the census, then let the pool retire with the key
    // fenced and the unresolved-child evidence re-read synchronously before termination.
    let attempts = 0
    let outcome: 'retired' | 'absent' | undefined
    for (;;) {
      // Awake evidence, read-only. An unresolved native child refuses outright.
      if (unresolvedChild(scope)) {
        log.warn('chat_handoff_refused', { ...from, reason: 'unresolved native child' })
        return { status: 'refused', reason: 'unresolved native child' }
      }
      const now = await phase(oldKey)
      if (now === 'absent') { outcome = 'absent'; break }
      let wait = now === 'busy'
      if (!wait) {
        const gate = await handoffCensusGate(scope, from)
        if (gate !== undefined && gate !== 'wait') return gate
        wait = gate === 'wait'
      }
      if (!wait) {
        const retired = await retire(oldKey, {
          keepResumableRow: options.keepResumable === true,
          stillIdle: () => !unresolvedChild(scope),
        })
        attempts += 1
        if (retired === 'retired' || retired === 'absent') { outcome = retired; break }
        // A first refusal is final (ownership or exit not confirmed); a later one is
        // re-observed until the deadline, since another retirement may hold the gate.
        if (retired === 'refused' && (attempts === 1 || unresolvedChild(scope))) return refused()
      }
      if (Date.now() >= deadline) break
      await pause()
    }
    if (outcome !== undefined) {
      if (!readmit(next.sessionKey)) {
        log.warn('chat_handoff_busy', { ...from, reason: 'next key still retiring' })
        return { status: 'busy', reason: 'the next Chat session is still retiring' }
      }
      log.info('chat_credential_handoff', { ...from, outcome })
      return { status: 'ready', retired: { sessionKey: oldKey, sessionId: owner.sessionId } }
    }
    log.warn('chat_handoff_busy', { ...from, reason: 'owner still in a turn', wait_ms: waitMs })
    return { status: 'busy', reason: 'the old Chat owner is still in a turn' }
  }

  const idleMs = deps.idleMs ?? PROJECT_SLEEP_IDLE_MS
  const now = deps.now ?? Date.now
  const LEASE_REASONS: ReadonlySet<AwakeReason> = new Set<AwakeReason>(['conversation', 'queuedDispatch', 'build', 'approval', 'liveChild'])

  /**
   * The SYNCHRONOUS awake evidence: every lease of the exact scope, the admission's
   * unresolved native child and pending approvals. Synchronous on purpose — the pool
   * re-reads it with the key fenced and no await before termination.
   */
  function admittedEvidence(scope: string | null): AwakeOutcome {
    const reasons = new Set<AwakeReason>()
    try {
      // Every lease of the exact scope, whichever boot produced it: restart does not
      // expire a lease, so a previous gateway's work still keeps the scope awake.
      for (const lease of deps.admission.listLeases()) {
        if (lease.scope.projectId !== scope) continue
        reasons.add(LEASE_REASONS.has(lease.reason) ? lease.reason : 'conversation')
      }
      if (deps.admission.hasUnresolvedNativeChildForChat(scope)) reasons.add('liveChild')
    } catch (error) {
      return { status: 'unknown', reason: `admission unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      for (const approval of deps.pendingApprovals?.() ?? []) {
        // An instance grant is decided by the gateway, not by any conversation, and
        // never expires unanswered: it keeps no scope awake (and never all of them).
        if (approval.instanceGrant === true) continue
        const attributed = deps.topicScope?.(approval.topicId)
        if (attributed === undefined) return { status: 'unknown', reason: 'a pending approval cannot be attributed to a scope' }
        if (attributed.scope === scope) reasons.add('approval')
      }
    } catch (error) {
      return { status: 'unknown', reason: `awake evidence unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
    return reasons.size > 0 ? { status: 'awake', reasons: [...reasons] } : { status: 'idle' }
  }

  async function awake(scope: string | null): Promise<AwakeOutcome> {
    const admitted = admittedEvidence(scope)
    if (admitted.status === 'unknown') return admitted
    const reasons = new Set<AwakeReason>(admitted.status === 'awake' ? admitted.reasons : [])
    try {
      const foreground = await deps.foregroundMs?.(scope)
      if (typeof foreground === 'number' && now() - foreground < idleMs) reasons.add('foreground')
    } catch (error) {
      return { status: 'unknown', reason: `awake evidence unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (reasons.size > 0) return { status: 'awake', reasons: [...reasons] }
    // The census last: unknown liveness never licenses closure, and an unbound
    // census (composition still building) is unknown, not idle.
    const surface = deps.liveness?.()
    if (surface === undefined) return { status: 'unknown', reason: 'liveness census not bound' }
    let census: Awaited<ReturnType<ProjectLivenessSurface['census']>>
    try { census = await surface.census(scope) } catch (error) {
      return { status: 'unknown', reason: `liveness census failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    const kind = census.parent.kind
    if (census.verdict === 'busy') return { status: 'awake', reasons: ['busy'] }
    if (kind === 'ambiguous' || kind === 'unidentified' || kind === 'legacy-unknown' || census.verdict !== 'idle') {
      return { status: 'unknown', reason: `liveness ${census.verdict} (${kind}): ${census.reasons.join('; ')}` }
    }
    return { status: 'idle' }
  }

  /** The scope's durable asleep conversations, newest first; unknown on an unreadable registry. */
  function asleepRows(scope: string | null): AsleepConversation[] | undefined {
    const read = deps.asleepConversations ?? (deps.registryPath === undefined
      ? undefined : (s: string | null) => readAsleepConversations(deps.registryPath!, s))
    if (read === undefined) return []
    try {
      const answer = read(scope)
      return answer.kind === 'answered' ? answer.rows : undefined
    } catch { return undefined }
  }

  function sleepScope(scope: string | null): Promise<SleepOutcome> {
    return withScope(scope, async () => {
      const outcome = await sleepOnce(scope)
      const level = outcome.status === 'retired' || outcome.status === 'absent' ? 'info' : 'warn'
      log[level]('project_scope_sleep', { scope, ...outcome })
      return outcome
    })
  }

  async function sleepOnce(scope: string | null): Promise<SleepOutcome> {
    const owner = await ownerFor(scope)
    if (owner.kind === 'ambiguous') return { status: 'unknown', reason: `ambiguous Chat owner: ${owner.count} live sessions` }
    // Foreign/unverified refuses BEFORE anything is killed: the manager's sample must
    // show this scope's own slot (or no slot at all).
    const inspect = deps.conversationTerminal?.inspectChat
    const before = inspect === undefined ? undefined : await inspect(scope)
    if (before?.status === 'refused') return { status: 'refused', reason: `workspace not verified: ${before.reason}` }
    if (owner.kind === 'none') {
      // The Codex refusal is decided by the FOUND owner, not the scope's current
      // provider: no Claude owner, and a Codex scope (or a live Chat the Claude pool
      // does not own) has no exact retirement authority. A Claude owner left behind by
      // a provider switch is still a Claude owner and sleeps below.
      if (deps.providerFor?.(scope) === 'openai-codex') return { status: 'refused', reason: 'codex owner: no exact retirement authority' }
      if (before?.status === 'live') return { status: 'refused', reason: 'the live Chat is not a Claude pool owner: no exact retirement authority' }
      return { status: 'absent' }
    }
    if (owner.spawning === true) return { status: 'refused', reason: 'owner still in a turn' }
    // The pool reports a live owner: the manager must agree (its live Chat), or not
    // track the scope at all. A gone or placeholder slot contradicts the pool, and
    // contradictory evidence never licenses closure.
    if (before !== undefined && before.status !== 'live' && before.status !== 'none') {
      return { status: 'unknown', reason: `workspace sample (${before.status}) contradicts the live Chat owner` }
    }
    // A live slot must be THIS owner's pane: retiring the pool owner while another
    // pane holds the Chat would leave a live Chat the wake cannot replace.
    if (before?.status === 'live' && (before.pane === undefined || before.pane !== owner.pane)) {
      return { status: 'unknown', reason: `workspace Chat pane (${before.pane ?? 'unknown'}) is not the live owner's pane (${owner.pane ?? 'unknown'})` }
    }
    const evidence = await awake(scope)
    if (evidence.status === 'awake') return { status: 'refused', reason: `awake: ${evidence.reasons.join(', ')}` }
    if (evidence.status === 'unknown') return { status: 'unknown', reason: evidence.reason }
    // Sleep never waits a turn out (unlike a handoff): a busy key refuses outright.
    if (await phase(owner.sessionKey) === 'busy') return { status: 'refused', reason: 'owner still in a turn' }
    // The pool fences the key, then re-reads the admitted evidence with no await
    // before termination: work admitted since the read above keeps the Chat.
    let arrived: AwakeOutcome | undefined
    const retired = await retire(owner.sessionKey, {
      keepResumableRow: true,
      stillIdle: () => {
        const now = admittedEvidence(scope)
        if (now.status === 'idle') return true
        arrived = now
        return false
      },
    })
    if (retired === 'deferred') {
      if (arrived?.status === 'awake') return { status: 'refused', reason: `awake: ${arrived.reasons.join(', ')}` }
      if (arrived?.status === 'unknown') return { status: 'unknown', reason: arrived.reason }
      return { status: 'refused', reason: 'owner still in a turn' }
    }
    if (retired === 'refused') return { status: 'refused', reason: 'the pool refused retirement (ownership or exit not confirmed)' }
    if (retired === 'absent') return { status: 'absent' }
    log.info('project_scope_slept', { scope, session_id: owner.sessionId, credential: owner.credentialId, outcome: retired })
    if (inspect === undefined || before === undefined || before.status === 'none') {
      return { status: 'retired', sessionId: owner.sessionId, workspace: 'left-for-reconciliation' }
    }
    // The pool closed the Chat pane (confirmed exit). Re-sample: anything but a
    // positively gone slot is logged and left for reconciliation — never closed here.
    const after = await inspect(scope)
    if (after.status !== 'gone') {
      log.warn('project_scope_sleep_pane_unconfirmed', { scope, status: after.status, ...('reason' in after ? { reason: after.reason } : {}) })
      return { status: 'retired', sessionId: owner.sessionId, workspace: 'left-for-reconciliation' }
    }
    return { status: 'retired', sessionId: owner.sessionId, workspace: 'pane-retired' }
  }

  async function isAsleep(scope: string | null): Promise<boolean> {
    if ((await ownerFor(scope)).kind !== 'none') return false
    return (asleepRows(scope)?.length ?? 0) > 0
  }

  /** The newest durable asleep row's credential — process memory is never the pin,
   * so a wake after a gateway restart keys the same pool identity and resumes it. */
  function resumeCredentialFor(scope: string | null): string | undefined {
    const credential = asleepRows(scope)?.[0]?.credentialId
    return credential === undefined || credential === '_nocred' ? undefined : credential
  }

  const timers = new Map<string | null, ReturnType<typeof setTimeout>>()
  function disarmIdle(scope: string | null): void {
    const timer = timers.get(scope)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(scope)
  }
  function armIdle(scope: string | null, delayMs = idleMs): void {
    if (idleMs <= 0) return
    disarmIdle(scope)
    const timer = setTimeout(() => {
      if (timers.get(scope) !== timer) return
      timers.delete(scope)
      fireAndForget('project-scope-lifecycle.sleep', sleepScope(scope).then(outcome => {
        // Awake/unknown: look again later (bounded by idleMs); retired/absent: done.
        if ((outcome.status === 'refused' || outcome.status === 'unknown') && !timers.has(scope)) armIdle(scope)
      }), error => {
        log.warn('project_scope_sleep_failed', { scope, error: error instanceof Error ? error.message : String(error) })
      })
    }, delayMs)
    timer.unref?.()
    timers.set(scope, timer)
  }
  function close(): void {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return {
    ownerFor, handoffChat, awake, sleep: sleepScope, isAsleep, resumeCredentialFor,
    armIdle: scope => armIdle(scope), disarmIdle, close,
  }
}
