/**
 * Focused unit coverage for `open/wiring/substrates.ts` (C3a carve).
 *
 * Constructs `wireSubstrates` with a fake wiring context + a capturing fake
 * `substrateFactory`, then dispatches each returned substrate/factory to pin the
 * CARE invariants the carve must preserve:
 *   - substrate instance-id prefixes are byte-identical (`cc-llm-`, `cc-agent-`,
 *     ephemeral `cc-trident-*`, warm `cc-trident-fire-*`);
 *   - `enableToolBridge: true` ONLY on the owner-facing conversational pair
 *     `cc-agent-*` + `cc-nudge-*`; the rest omit it — asserted as an enumerated
 *     set over every wired substrate, never as a positive case with an
 *     exclusive-sounding title;
 *   - `cc-trident-fire-*` is WARM per repo cwd (Map cache: same cwd → same id +
 *     same instance; distinct cwd → distinct id) and NON-ephemeral;
 *   - `prewarmReady` never rejects and `prewarmSettledRef.settled` flips true
 *     only AFTER the pre-warm resolves (live reference, not a boot snapshot);
 *   - LLM-less (`llmPool: null`) leaves the warm substrates null and the
 *     factories throwing.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { replToolBridgeRef } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import {
  githubSpawnEnvRef,
  setGithubSpawnEnvResolver,
} from '@neutronai/gateway/wiring/substrate-profiles.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { dispatchBoardBoundBuild } from '@neutronai/trident/board-dispatch.ts'
import { buildBoardReconcileObserver } from '@neutronai/trident/board-reconcile.ts'
import { buildTridentOrchestrator } from '@neutronai/trident/orchestrator.ts'
import { TridentTickLoop } from '@neutronai/trident/tick.ts'
import {
  registerSupervisedSubstrate,
  runReplWatchdogTick,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { saveRegistry } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import {
  resolveOpenModelProvider,
  resolveOpenOpenAiPool,
  buildOpenAiMcpResolver,
  buildOpenAiToolManifest,
  resolveOpenConversationalProvider,
} from '../composer.ts'

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ok' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

const SESSIONLESS_SPEC: AgentSpec = { prompt: 'x', tools: [], model_preference: ['sonnet'] }

function makeCtx(
  overrides: Partial<OpenWiringContext> = {},
): { ctx: OpenWiringContext; captured: ClaudeCodeSubstrateOptions[]; prewarmCalls: Substrate[] } {
  const captured: ClaudeCodeSubstrateOptions[] = []
  const prewarmCalls: Substrate[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return { start: () => cannedHandle(opts.substrate_instance_id) }
  }
  const ctx: OpenWiringContext = {
    llmPool: newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }],
    }),
    owner_handle: 'owner',
    owner_home: '/tmp/owner-home',
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    substrateFactory,
    prewarmSubstrate: async (s: Substrate): Promise<void> => {
      prewarmCalls.push(s)
    },
    ...overrides,
  }
  return { ctx, captured, prewarmCalls }
}

/** Drain a session handle's events so the fake factory records its opts. */
async function drain(sub: Substrate): Promise<void> {
  const handle = sub.start(SESSIONLESS_SPEC)
  for await (const _ of handle.events) {
    /* consume */
  }
}

/**
 * Drain EVERY substrate this wiring builds, so an "only X does Y" claim is a
 * measured set difference rather than a positive assertion wearing an exclusive
 * title. Nullable entries are LLM-less compositions; skip those, and the callers
 * assert a non-empty result so a wholesale null cannot make the claim vacuous.
 *
 * Anything added to `WiredSubstrates` must be drained here — that is the point:
 * a new substrate joins every exclusivity assertion automatically instead of
 * being silently outside them.
 */
async function drainEveryWiredSubstrate(w: ReturnType<typeof wireSubstrates>): Promise<void> {
  await drain(w.makeEphemeralSubstrate('cc-trident')('/repo/one'))
  await drain(w.makeWarmFireSubstrate('/repo/alpha'))
  for (const s of [
    w.liveAgentSubstrate,
    w.llmCallSubstrate,
    w.reminderComposeSubstrate,
    w.makeComposeSubstrate('proj'),
  ]) {
    if (s !== null) await drain(s)
  }
}

// `githubSpawnEnvRef` is module-level state a composer registers at boot, so a
// composer test running earlier IN THE SAME SHARD leaves a live resolver behind
// and every profile that opts into the credential then calls it. CI found this;
// a local single-file run never could. Clear it so this file measures its own
// wiring rather than whatever ran before it.
beforeEach(() => {
  githubSpawnEnvRef.resolve = undefined
})

describe('wireSubstrates — instance ids + tool-bridge invariants', () => {
  test('cc-llm-* phase-spec substrate omits the tool bridge', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).not.toBeNull()
    await drain(w.llmCallSubstrate!)
    const opts = captured.find((o) => o.substrate_instance_id === 'cc-llm-owner')
    expect(opts).toBeDefined()
    expect(opts!.enableToolBridge).not.toBe(true)
    expect(opts!.ephemeral).not.toBe(true)
    expect(opts!.skip_permissions).toBe(true)
  })

  test('ONLY the owner-facing conversational pair opts into the tool bridge', async () => {
    // ENUMERATED, not asserted-positive-and-titled-"only". The earlier version of
    // this test drained `cc-agent-*` alone and asserted its bridge was on, so the
    // exclusivity lived entirely in the title — and went quietly false the moment a
    // second substrate was granted the bridge. Drain EVERY substrate this wiring
    // builds and compare the whole set.
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    await drainEveryWiredSubstrate(w)

    const bridged = new Set(
      captured.filter((o) => o.enableToolBridge === true).map((o) => o.substrate_instance_id),
    )
    // `cc-nudge-*` is the background proactive-compose lane. It is an equal-grant,
    // SEPARATE-SESSION twin of the chat lane on purpose: a ritual composes there and
    // ISSUES #504 settled that it must reach Core tools (the locked-down `cc-ritual-*`
    // sandbox is exactly what that issue deleted, after the morning brief could not
    // read the owner's calendar). Its containment is the approval gate, not the
    // substrate. If a THIRD id ever appears here, that is a real privilege change and
    // this test is the place it must be argued.
    expect([...bridged].sort()).toEqual(['cc-agent-owner', 'cc-nudge-owner'])

    for (const id of bridged) {
      const opts = captured.find((o) => o.substrate_instance_id === id)!
      expect(opts.ephemeral, id).not.toBe(true)
      expect(opts.skip_permissions, id).toBe(true)
    }
  })

  test('THE PROFILE DECIDES which substrates carry the GitHub credential', async () => {
    // The decision is not made here and not at the construction sites — it is on
    // the profile, so a substrate added later inherits whatever its profile
    // already decided instead of silently getting nothing. That silence is what
    // produced ISSUES #576 and a private-repo build dying at `could not read
    // Username`.
    let calls = 0
    setGithubSpawnEnvResolver(async () => {
      calls += 1
      return { GH_TOKEN: 'probe-value' }
    })
    try {
      const { ctx, captured } = makeCtx()
      const w = wireSubstrates(ctx)

      // WIRING ALONE MUST NOT RESOLVE IT. The composer closes over a secrets
      // store it builds later in its own scope, so an eager call would be a
      // temporal-dead-zone crash at boot rather than a wrong token.
      expect(calls).toBe(0)

      // cc-agent-* runs on PROFILE_WARM_CHAT (github_credential: true).
      await drain(w.liveAgentSubstrate!)
      const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')
      expect(agent!.env!['GH_TOKEN']).toBe('probe-value')
      // …and the helper that makes raw `git` work, not just `gh`.
      expect(agent!.env!['GIT_CONFIG_KEY_0']).toBeUndefined() // supplied by the real resolver, not this probe
      expect(calls).toBeGreaterThan(0)

      // cc-llm-* runs on PROFILE_PHASE_SPEC (github_credential: false) — its
      // input is user-controlled onboarding text.
      await drain(w.llmCallSubstrate!)
      const llm = captured.find((o) => o.substrate_instance_id === 'cc-llm-owner')
      expect(llm!.env!['GH_TOKEN']).toBeUndefined()
    } finally {
      githubSpawnEnvRef.resolve = undefined
    }
  })

  test('A FAILING credential read degrades the spawn, it does not kill it', async () => {
    // Surfaced by CI: the resolver threw and took the whole substrate down with
    // it. In production that is a locked store turning a chat turn into a dead
    // session — strictly worse than having no credential, which merely makes
    // `gh` fail with git's own message.
    setGithubSpawnEnvResolver(async () => {
      throw new Error('secrets store unavailable')
    })
    try {
      const { ctx, captured } = makeCtx()
      const w = wireSubstrates(ctx)
      await drain(w.liveAgentSubstrate!)
      const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')
      expect(agent).toBeDefined()
      expect(agent!.env!['GH_TOKEN']).toBeUndefined()
    } finally {
      githubSpawnEnvRef.resolve = undefined
    }
  })

  test('no registered resolver ⇒ every spawn env is byte-for-byte unchanged', async () => {
    githubSpawnEnvRef.resolve = undefined
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    await drain(w.liveAgentSubstrate!)
    const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')
    expect(agent!.env!['GH_TOKEN']).toBeUndefined()
  })

  test('makeComposeSubstrate: per-project ISOLATED compose session — keyed by project_id, distinct pool key from cc-agent, TOOLLESS (#377/#378 white-box)', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    const sAxi = w.makeComposeSubstrate('axiom')
    const sDtc = w.makeComposeSubstrate('dtc-ops')
    expect(sAxi).not.toBeNull()
    expect(sDtc).not.toBeNull()
    await drain(sAxi!)
    await drain(sDtc!)
    const composeOpts = captured.filter((o) => o.substrate_instance_id === 'cc-compose-owner')
    expect(composeOpts.length).toBe(2)
    // (b) DISTINCT pool-key namespace from the live-chat cc-agent session, so a
    // compose can NEVER collide with / evict the owner's live-chat REPL (B1).
    expect(composeOpts.every((o) => o.substrate_instance_id !== 'cc-agent-owner')).toBe(true)
    // (a) keyed BY project_id — each compose folds ITS project into the warm-pool
    // key (S3 §2 project dimension) → a distinct transcript per project (no #378).
    expect(composeOpts.map((o) => o.project_id)).toEqual(['axiom', 'dtc-ops'])
    // (c) TOOLLESS + none of the owner-chat delivery sinks (untrusted doc-derived
    // input has no tool surface and never posts to the owner's chat — B2).
    for (const o of composeOpts) {
      expect(o.enableToolBridge).not.toBe(true)
      expect(o.ephemeral).not.toBe(true)
      expect(o.onDeadTurnNotice).toBeUndefined()
      expect(o.onSizeAlert).toBeUndefined()
      expect(o.onRateLimitBanner).toBeUndefined()
      expect(o.onModelFloorApplied).toBeUndefined()
      expect(o.onRecoveredReply).toBeUndefined()
      expect(o.delivery_topic_id).toBeUndefined()
      expect(o.skip_permissions).toBe(true)
    }
  })

  test('NO MID-TURN KILL: a compose for project X never shares the cc-agent pool key of an in-flight live turn on X (B1)', async () => {
    const onRateLimitBanner = (): void => {}
    const { ctx, captured } = makeCtx({
      liveAgentNoticeSinks: {
        onDeadTurnNotice: () => {},
        onSizeAlert: () => {},
        onRateLimitBanner,
        onModelFloorApplied: () => {},
      },
      liveAgentDeliveryTopicId: 'app:owner',
    })
    const w = wireSubstrates(ctx)
    // A live-chat turn for project X is in flight (its cc-agent pool entry).
    await drain(w.liveAgentSubstrate!)
    // Compose an opening for the SAME project X concurrently.
    await drain(w.makeComposeSubstrate('project-x')!)
    const agent = captured.filter((o) => o.substrate_instance_id === 'cc-agent-owner')
    const compose = captured.filter((o) => o.substrate_instance_id === 'cc-compose-owner')
    expect(agent.length).toBe(1)
    expect(compose.length).toBe(1)
    // The warm-pool key = (instance_id, user_id, project_id, credential). The
    // compose's instance id differs from cc-agent's, so even for the SAME project
    // + owner the two keys can never collide → the live turn's REPL is never
    // evicted/terminated by a compose (the exact #419 B1 hazard, now closed).
    expect(compose[0]!.substrate_instance_id).not.toBe(agent[0]!.substrate_instance_id)
    // And the compose carries NONE of the owner-facing sinks the live agent holds,
    // so a compose banner/notice never posts to the owner's chat (B2 side-effect).
    expect(agent[0]!.onRateLimitBanner).toBe(onRateLimitBanner)
    expect(compose[0]!.onRateLimitBanner).toBeUndefined()
    expect(compose[0]!.delivery_topic_id).toBeUndefined()
  })

  test('O6: notice + recovered-reply sinks wire ONLY onto cc-agent-* (not cc-llm-*/trident)', async () => {
    const onDeadTurnNotice = (): void => {}
    const onSizeAlert = (): void => {}
    const onRateLimitBanner = (): void => {}
    const onModelFloorApplied = (): void => {}
    const onRecoveredReply = (): void => {}
    const { ctx, captured } = makeCtx({
      liveAgentNoticeSinks: { onDeadTurnNotice, onSizeAlert, onRateLimitBanner, onModelFloorApplied },
      liveAgentRecoveredReplySink: onRecoveredReply,
      liveAgentDeliveryTopicId: 'app:owner',
    })
    const w = wireSubstrates(ctx)
    // Drain both conversational substrates + one ephemeral so all opts are captured.
    await drain(w.liveAgentSubstrate!)
    await drain(w.llmCallSubstrate!)
    await drain(w.makeEphemeralSubstrate('cc-trident')('/repo/x'))

    const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')!
    // The owner's conversational REPL carries all four sinks + the delivery topic.
    expect(agent.onDeadTurnNotice).toBe(onDeadTurnNotice)
    expect(agent.onSizeAlert).toBe(onSizeAlert)
    expect(agent.onRateLimitBanner).toBe(onRateLimitBanner)
    // The floor-clamp notice rides the SAME wiring — it is the fourth member of
    // the family now, and without it a clamp is a stderr line on a box the owner
    // does not read (the silence that let the degradation run for a day).
    expect(agent.onModelFloorApplied).toBe(onModelFloorApplied)
    expect(agent.onRecoveredReply).toBe(onRecoveredReply)
    expect(agent.delivery_topic_id).toBe('app:owner')

    // The phase-spec (cc-llm-*) + ephemeral trident substrates must NOT — a notice
    // there has no owner chat surface to deliver to (stderr-only default).
    const llm = captured.find((o) => o.substrate_instance_id === 'cc-llm-owner')!
    const trident = captured.find((o) => o.substrate_instance_id === 'cc-trident-owner')!
    for (const o of [llm, trident]) {
      expect(o.onDeadTurnNotice).toBeUndefined()
      expect(o.onSizeAlert).toBeUndefined()
      expect(o.onRateLimitBanner).toBeUndefined()
      expect(o.onRecoveredReply).toBeUndefined()
      expect(o.delivery_topic_id).toBeUndefined()
    }
  })

  test('makeEphemeralSubstrate builds a per-cwd ephemeral cc-<prefix>-* substrate (no bridge)', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    const sub = w.makeEphemeralSubstrate('cc-trident')('/repo/one')
    await drain(sub)
    const opts = captured.find((o) => o.substrate_instance_id === 'cc-trident-owner')
    expect(opts).toBeDefined()
    expect(opts!.ephemeral).toBe(true)
    expect(opts!.enableToolBridge).not.toBe(true)
    expect(opts!.cwd).toBe('/repo/one')
  })

  test('makeWarmFireSubstrate is WARM per repo cwd: cached same-cwd, distinct id per cwd, no bridge, not ephemeral', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    const a1 = w.makeWarmFireSubstrate('/repo/alpha')
    const a2 = w.makeWarmFireSubstrate('/repo/alpha')
    const b1 = w.makeWarmFireSubstrate('/repo/beta')
    // Same cwd → the SAME cached substrate instance (warm reuse).
    expect(a1).toBe(a2)
    // Distinct cwd → a distinct substrate.
    expect(a1).not.toBe(b1)
    await drain(a1)
    await drain(b1)
    const fireOpts = captured.filter((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))
    const ids = new Set(fireOpts.map((o) => o.substrate_instance_id))
    // Two distinct repo cwds → two distinct fire instance ids.
    expect(ids.size).toBe(2)
    for (const o of fireOpts) {
      expect(o.enableToolBridge).not.toBe(true)
      expect(o.ephemeral).not.toBe(true)
    }
  })

  test('the PRODUCTION fire substrate carries the long inactivity window — and no other substrate does', async () => {
    // THE WIRING, not the function. The window is useless unless the real
    // `wireSubstrates` output carries it, and this repo has been bitten
    // repeatedly by a capability that exists and is never connected. These opts
    // come from the production composer with an injected factory, so this fails
    // if `substrates.ts` ever stops passing `PROFILE_WARM_FIRE`.
    //
    // The defect it guards: the default 90s window measures liveness as PTY
    // bytes, and on a trip the pool poisons + respawns the warm session — killing
    // the detached build it hosts. Both owner attempts at the Email Core P1 build
    // died that way (2026-08-07, 2026-08-10) during `plan:fable`.
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    await drain(w.makeWarmFireSubstrate('/repo/alpha'))
    // Every OTHER substrate this composition builds, drained through the same
    // factory, so "only the fire one" is a measured claim rather than a hope.
    // Several are nullable (LLM-less compositions); drain whichever exist and
    // assert below that we actually collected some, so a wholesale null does not
    // turn this into a vacuous pass.
    await drainEveryWiredSubstrate(w)

    const fire = captured.filter((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))
    expect(fire.length).toBeGreaterThan(0)
    for (const o of fire) expect(o.turn_inactivity_ms).toBe(30 * 60_000)

    const others = captured.filter((o) => !o.substrate_instance_id.startsWith('cc-trident-fire-'))
    expect(others.length).toBeGreaterThan(0)
    for (const o of others) expect(o.turn_inactivity_ms).toBeUndefined()
  })

  test('ONLY the two PROFILE_WARM_CHAT substrates carry the frontier-model floor', async () => {
    // THE WIRING, not the constant — same reasoning as the fire-window test
    // directly above. The floor is worthless unless the REAL composition passes
    // `PROFILE_WARM_CHAT` down to the spawn, and the counter-assertion matters
    // just as much: scribe/reflection/phase-spec run on FAST_MODEL deliberately,
    // so a floor leaking onto them would be a quota and latency regression.
    //
    // The defect it guards: a REPL registry row OVERRIDES the best model
    // (`record.model ?? getBestModel()`), and the spawn writes the row back, so a
    // single wrong value is permanent. The owner's project chat ran a full day on
    // Haiku on that path, twice in one day — which is ALSO why the background
    // nudge lane carries the floor: a fired reminder used to compose on the chat
    // session and rewrite its registry row to the fast tier. It now composes on
    // its own child, and that child must not be the cheap one either.
    //
    // ⚠️ SCOPE, stated because the counter-assertion below reads wider than it is:
    // this drives `wireSubstrates` ONLY. The scribe extractor, the correction judge
    // and the consolidation pass — the deliberate fast-tier callers the counter-
    // assertion is really about — are built by `wireMemory`, so flipping one of
    // THEM onto the chat profile would not fail here. That half lives in
    // `open-wiring-memory.test.ts` § "no memory substrate carries the frontier-
    // model floor", which drives the real memory call sites.
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    await drainEveryWiredSubstrate(w)

    const floored = new Set(
      captured.filter((o) => o.frontier_model_floor === true).map((o) => o.substrate_instance_id),
    )
    expect([...floored].sort()).toEqual(['cc-agent-owner', 'cc-nudge-owner'])

    const others = captured.filter((o) => !floored.has(o.substrate_instance_id))
    expect(others.length).toBeGreaterThan(0)
    for (const o of others) {
      expect(o.frontier_model_floor, o.substrate_instance_id).not.toBe(true)
    }
  })

  test('BOTH floored substrates get a floor-clamp sink, and they get DIFFERENT ones', async () => {
    // THE GAP THIS CLOSES. The test directly above proves the nudge lane is floored,
    // so `applyModelFloor` CAN clamp it — and that lane was built with no notice sink
    // at all, which made its clamp a stderr line on a box nobody reads. That is the
    // exact silent degradation the floor notice exists to end, reintroduced on a new
    // lane. A comment in `substrates.ts` had also claimed the chat lane was "the only
    // one that can ever emit the notice", which this file's own assertion disproved.
    //
    // Why two sinks and not one: the chat lane's sink BUBBLES into the owner's chat,
    // which is right when he is sitting in the conversation that degraded and wrong
    // when a timer fired it. The nudge lane takes the journal-only sink, so the clamp
    // is durably recorded without a background lane pushing anything into his chat.
    // If a future edit hands the nudge lane `liveAgentNoticeSinks` instead, the
    // identity assertions below fail rather than shipping a timer-driven bubble.
    const liveFloor = (): void => {}
    const journalFloor = (): void => {}
    const { ctx, captured } = makeCtx({
      liveAgentNoticeSinks: {
        onDeadTurnNotice: () => {},
        onSizeAlert: () => {},
        onRateLimitBanner: () => {},
        onModelFloorApplied: liveFloor,
      },
      backgroundNoticeSinks: {
        onDeadTurnNotice: () => {},
        onSizeAlert: () => {},
        onRateLimitBanner: () => {},
        onModelFloorApplied: journalFloor,
      },
    })
    const w = wireSubstrates(ctx)
    await drainEveryWiredSubstrate(w)

    const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')!
    const nudge = captured.find((o) => o.substrate_instance_id === 'cc-nudge-owner')!

    // No floored substrate is left on the stderr fallback.
    expect(agent.onModelFloorApplied).toBe(liveFloor)
    expect(nudge.onModelFloorApplied).toBe(journalFloor)
    expect(nudge.onModelFloorApplied).not.toBe(agent.onModelFloorApplied)

    // The lane's other promise is unchanged: the three CHAT-TURN notice seams and
    // the recovered-reply/delivery seams stay omitted, so nothing else from a timer
    // can reach his chat. Only the floor clamp crossed, and only to the journal.
    expect(nudge.onDeadTurnNotice).toBeUndefined()
    expect(nudge.onSizeAlert).toBeUndefined()
    expect(nudge.onRateLimitBanner).toBeUndefined()
    expect(nudge.onRecoveredReply).toBeUndefined()
    expect(nudge.delivery_topic_id).toBeUndefined()
    // (`credential_failure_lane` is deliberately NOT asserted here: it is a
    // `buildLlmCallSubstrate` input consumed by the pool reporter, not an adapter
    // option, so it never appears on `captured`. It is pinned where it is actually
    // observable — `background-lane-never-locks-out-owner.test.ts`.)

    // COUNTER-ASSERTION — the journal-only sink did not leak onto anything else.
    for (const o of captured) {
      if (o.substrate_instance_id === 'cc-nudge-owner') continue
      expect(o.onModelFloorApplied, o.substrate_instance_id).not.toBe(journalFloor)
    }
  })

  test('production watchdog wiring reaps a capped pid-dead run, then one tick aligns count and board (#514)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-open-crash-reap-'))
    const db = ProjectDb.open(join(dir, 'project.db'))
    try {
      applyMigrations(db.raw())
      const runs = new TridentRunStore(db)
      const board = new WorkBoardStore(db)
      const item = await board.create('owner', {
        title: 'build the email core with tests and wire it to the application',
      })
      const dispatched = await dispatchBoardBoundBuild(
        { board_item_id: item.id, task: 'build the email core' },
        {
          store: runs,
          board,
          project_slug: 'owner',
          repo_path: '/repo/dead',
          resolveBuildRepo: async (home) => home,
          resolveMergeMode: async () => 'pr',
          resolveRalph: async () => false,
        },
      )
      expect(dispatched.ok).toBe(true)
      const dead = dispatched.ok ? dispatched.run : null
      expect(dead).not.toBeNull()
      const live = await runs.create({ slug: 'live', project_slug: 'owner', repo_path: '/repo/live', task: 'live' })
      await runs.update(live.id, { subagent_status: 'running', subagent_run_id: 'wf-live', workflow_run_id: 'healthy-key' })
      const orch = buildTridentOrchestrator({
        fire_workflow: async () => ({ status: 'fired', run_id: 'wf-dead', error: null }),
        db_path: join(dir, 'project.db'),
        run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
      })
      const loop = new TridentTickLoop({
        store: runs,
        step: orch.step,
        on_terminal: { onTerminal: buildBoardReconcileObserver(board)! },
      })
      await loop.runOnce()
      expect(runs.get(dead!.id)?.subagent_status).toBe('running')

      const { ctx, captured } = makeCtx({ db })
      await drain(wireSubstrates(ctx).makeWarmFireSubstrate('/repo/dead'))
      const wired = captured.find((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))!
      const registryPath = join(dir, 'repl-registry.json')
      const supervised = { ...wired, replRegistryPath: registryPath } as PersistentReplSubstrateOptions
      const sessionKey = poolKeyFor(supervised)
      const generationKey = 'dead-generation'
      await runs.update(dead!.id, { workflow_run_id: generationKey })
      saveRegistry(registryPath, {
        [sessionKey]: {
          sessionKey,
          sessionId: 'dead-session',
          cwd: '/repo/dead',
          channelName: 'dead-channel',
          has_session: true,
          pid: 999_999,
          child_generation: generationKey,
          first_ready_at: 1,
          capped_at: 2,
        },
      })
      registerSupervisedSubstrate(supervised)

      // Mutations killed: deleting either production callback forwarding seam,
      // or firing only from respawn-and-alert, leaves this capped run running.
      const watchdog = await runReplWatchdogTick(supervised, {
        healthProbe: async () => false,
        isPidAlive: () => false,
        now: () => 120_000,
      })
      expect(watchdog.find((entry) => entry.sessionKey === sessionKey)?.action).toBe('cap-hit-alert')
      expect(runs.get(dead!.id)?.subagent_status).toBe('crashed')
      expect(runs.get(live.id)?.subagent_status).toBe('running')

      // #240 / T2 — the latched crash reason must carry the MEASURED cause
      // (observation time + gateway process boot time), not a bare detail
      // string. Mutation killed: stripping the timestamp composition in
      // onChildCrash makes this regex fail.
      const latched = runs.get(dead!.id)?.failure_reason ?? ''
      expect(latched).toContain('inner workflow child crashed')
      expect(latched).toMatch(
        /observed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z; gateway process booted \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
      )
      expect(latched.toLowerCase()).not.toContain('exhausted')

      await loop.runOnce()
      const stored = runs.get(dead!.id)!
      expect(stored.phase).toBe('failed')
      expect(stored.subagent_status).toBe('crashed')
      // Mutation killed: the UI count uses this phase-based production query;
      // counting only subagent_status would miss phase/status divergence.
      expect(runs.listNonTerminal().filter((run) => run.id === dead!.id)).toHaveLength(0)
      expect(board.get('owner', item.id)?.status).toBe('failed')
      expect(board.list('owner').filter((candidate) => candidate.status === 'in_progress')).toHaveLength(0)
    } finally {
      await shutdownAllPersistentRepls()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('wireSubstrates — swappable provider (trident stays Claude Code)', () => {
  function openaiCtxOverrides(): Partial<OpenWiringContext> {
    return {
      provider: 'openai',
      openaiLlmPool: newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'openai:k', kind: 'api_key', secret: 'sk-openai' }],
      }),
      bindMcpResolver: () => async () => ({}),
    }
  }

  /** A recording fetch capturing each OpenAI request body (SSE completion reply). */
  function recordingOpenAiFetch(): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = []
    const sse =
      [
        { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
        { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
      ]
        .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
        .join('\n') + '\n'
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, bodies }
  }

  test('CAPABILITY PARITY (audit round 16): phase-spec (cc-llm) advertises NO tools; live-agent (cc-agent) advertises the manifest', async () => {
    const rec = recordingOpenAiFetch()
    const { ctx } = makeCtx({
      ...openaiCtxOverrides(),
      // A real MCP tool is in the manifest — it must reach ONLY the live-agent turn.
      toolManifest: () => [{ name: 'work_board_add', description: 'add', input_schema: { type: 'object' } }],
      openaiFetchImpl: rec.fetchImpl,
    })
    const w = wireSubstrates(ctx)
    // Phase-spec (onboarding, user-controlled) — must advertise NO MCP tools.
    await drain(w.llmCallSubstrate!)
    // Live-agent (post-onboarding chat) — mirrors enableToolBridge → tools present.
    await drain(w.liveAgentSubstrate!)
    expect(rec.bodies).toHaveLength(2)
    // bodies[0] = phase-spec: NO tools advertised (no privilege escalation).
    expect(rec.bodies[0]!['tools']).toBeUndefined()
    // bodies[1] = live-agent: the manifest tool IS advertised.
    const liveTools = (rec.bodies[1]!['tools'] as Array<{ name: string }> | undefined) ?? []
    expect(liveTools.map((t) => t.name)).toEqual(['work_board_add'])
  })

  test('provider=openai: trident-fire + ephemeral substrates STILL dispatch through the Claude Code factory', async () => {
    // The CC-typed `substrateFactory` is used ONLY by the anthropic path. If the
    // trident substrates recorded into `captured`, they are on Claude Code —
    // exactly the hard constraint (trident's Workflow inner loop is CC-only).
    const { ctx, captured } = makeCtx(openaiCtxOverrides())
    const w = wireSubstrates(ctx)
    await drain(w.makeWarmFireSubstrate('/repo/alpha'))
    await drain(w.makeEphemeralSubstrate('cc-trident')('/repo/one'))
    expect(captured.some((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))).toBe(true)
    expect(captured.some((o) => o.substrate_instance_id === 'cc-trident-owner')).toBe(true)
  })

  test('provider=openai: conversational substrates are built (non-null) and do NOT use the CC fake factory', async () => {
    const { ctx, captured } = makeCtx(openaiCtxOverrides())
    const w = wireSubstrates(ctx)
    // Constructed for the openai provider (routing to the gpt adapter happens at
    // dispatch — not exercised here to avoid a live HTTP call).
    expect(w.llmCallSubstrate).not.toBeNull()
    expect(w.liveAgentSubstrate).not.toBeNull()
    // The conversational substrates were NOT built on the CC fake path — only the
    // trident/ephemeral ones would be, and none were dispatched here.
    expect(captured.some((o) => o.substrate_instance_id === 'cc-agent-owner')).toBe(false)
    expect(captured.some((o) => o.substrate_instance_id === 'cc-llm-owner')).toBe(false)
  })

  test('OpenAI-ONLY box (llmPool null, openai pool present): conversational substrates are BUILT (Codex blocker fix)', () => {
    // Repro: NEUTRON_MODEL_PROVIDER=openai + OPENAI_API_KEY, NO Claude credential.
    // Pre-fix these nulled out because construction gated on the Anthropic llmPool.
    const { ctx } = makeCtx({ ...openaiCtxOverrides(), llmPool: null })
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).not.toBeNull()
    expect(w.liveAgentSubstrate).not.toBeNull()
    // No Anthropic pool → no CC pre-warm fired (openai is stateless HTTP).
    expect(w.prewarmReady).toBeNull()
    expect(w.prewarmSettledRef.settled).toBe(true)
    // Trident stays Claude-Code-ONLY: with no Anthropic pool an autonomous build
    // cannot run, and the factory throws LOUDLY (never silently no-ops on GPT).
    expect(() => w.makeWarmFireSubstrate('/repo')).toThrow(/empty Anthropic credential pool/)
    expect(() => w.makeEphemeralSubstrate('cc-trident')('/repo')).toThrow(
      /empty Anthropic credential pool/,
    )
  })

  test('OPERATOR OVERRIDE: NEUTRON_OPENAI_MODEL on ctx.env is the model SENT on the wire (not the ambient global)', async () => {
    // Regression (audit round 11): the model preference must resolve from the
    // composer's SELECTED env (ctx.env), not global process.env. Drive a real GPT
    // dispatch through wireSubstrates + a recording fetch and assert body.model.
    let sentModel: unknown
    const recordingFetch = (async (_url: string | URL, init?: RequestInit) => {
      sentModel = (JSON.parse(String(init?.body)) as { model?: unknown }).model
      const sse =
        [
          { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
          { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
        ]
          .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
          .join('\n') + '\n'
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = makeCtx({
      ...openaiCtxOverrides(),
      // The composer's selected env carries the override; global process.env does NOT.
      env: { NEUTRON_OPENAI_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv,
      openaiFetchImpl: recordingFetch,
    })
    const w = wireSubstrates(ctx)
    await drain(w.liveAgentSubstrate!)
    expect(sentModel).toBe('custom-model')
  })

  test('provider=openai but missing openai pool ⇒ FAILS LOUDLY (terminal error), NEVER silent Anthropic fallback', async () => {
    // An EXPLICIT openai selection must be honored even when incomplete — routing
    // the operator's prompts to Anthropic (the unselected provider) is the exact
    // silent-fallback bug this guards against (audit High).
    const { ctx, captured } = makeCtx({ provider: 'openai', openaiLlmPool: null, bindMcpResolver: () => async () => ({}) })
    const w = wireSubstrates(ctx)
    expect(w.liveAgentSubstrate).not.toBeNull()
    // Draining yields a LOUD terminal error and NEVER dispatches through the CC
    // fake factory (which only the anthropic path uses).
    const handle = w.liveAgentSubstrate!.start(SESSIONLESS_SPEC)
    const events: Event[] = []
    for await (const e of handle.events) events.push(e)
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.message).toMatch(/openai/i)
    // The Claude Code fake factory was NOT invoked — no silent Anthropic dispatch.
    expect(captured.some((o) => o.substrate_instance_id === 'cc-agent-owner')).toBe(false)
  })
})

describe('open composer — swappable provider boot helpers', () => {
  test('resolveOpenModelProvider reads NEUTRON_MODEL_PROVIDER, defaults anthropic, THROWS on typo', () => {
    expect(resolveOpenModelProvider({} as NodeJS.ProcessEnv)).toBe('anthropic')
    expect(resolveOpenModelProvider({ NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv)).toBe('openai')
    // Root-cause fix: an unknown value is a LOUD boot error, NOT a silent Claude fallback.
    expect(() =>
      resolveOpenModelProvider({ NEUTRON_MODEL_PROVIDER: 'nonsense' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Unknown model provider 'nonsense'/)
  })

  test('resolveOpenOpenAiPool resolves an api_key pool from OPENAI_API_KEY, null otherwise', () => {
    expect(resolveOpenOpenAiPool({} as NodeJS.ProcessEnv)).toBeNull()
    const pool = resolveOpenOpenAiPool({ OPENAI_API_KEY: 'sk-o' } as unknown as NodeJS.ProcessEnv)
    expect(pool).not.toBeNull()
    expect(pool!.credentials[0]!.kind).toBe('api_key')
    expect(pool!.credentials[0]!.secret).toBe('sk-o')
  })

  test('buildOpenAiMcpResolver: the project-bound resolver throws loudly when the tool bridge is not yet wired', async () => {
    const resolver = buildOpenAiMcpResolver()({ project_id: 'proj-x' })
    await expect(resolver({ call_id: 'c', tool_name: 't', args: {} })).rejects.toThrow(/tool bridge not wired/i)
  })

  test('PROJECT SCOPING (audit High): the bound resolver forwards project_id to ReplToolBridge.dispatch', async () => {
    // The production defect: a project-scoped tool (work_board_*, dispatch, …)
    // invoked from a GPT turn must reach ReplToolBridge.dispatch WITH the active
    // project_id — exactly like the Claude path threads it. Assert the DISPATCHED
    // context carries the bound project.
    const dispatched: Array<{ tool_name: string; project_id: string | null | undefined }> = []
    const prev = replToolBridgeRef.current
    replToolBridgeRef.current = {
      listToolSchemas: () => [{ name: 'work_board_add', description: 'x', input_schema: { type: 'object' } }],
      dispatch: async (input: {
        tool_name: string
        args: unknown
        call_id: string
        project_id?: string | null
      }) => {
        dispatched.push({ tool_name: input.tool_name, project_id: input.project_id })
        return { ok: true }
      },
    }
    try {
      const resolver = buildOpenAiMcpResolver()({ project_id: 'proj-77' })
      await resolver({ call_id: 'c1', tool_name: 'work_board_add', args: { title: 't' } })
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]!.tool_name).toBe('work_board_add')
      expect(dispatched[0]!.project_id).toBe('proj-77')
    } finally {
      replToolBridgeRef.current = prev
    }
  })

  test('PROJECT SCOPING: an ABSENT project binds to null (General/default scope), matching the CC sink fallback', async () => {
    const dispatched: Array<{ project_id: string | null | undefined }> = []
    const prev = replToolBridgeRef.current
    replToolBridgeRef.current = {
      listToolSchemas: () => [],
      dispatch: async (input: { project_id?: string | null }) => {
        dispatched.push({ project_id: input.project_id })
        return {}
      },
    }
    try {
      const resolver = buildOpenAiMcpResolver()({}) // no project_id
      await resolver({ call_id: 'c', tool_name: 't', args: {} })
      expect(dispatched[0]!.project_id).toBeNull()
    } finally {
      replToolBridgeRef.current = prev
    }
  })
})

describe('resolveOpenConversationalProvider — every declared value dispatches coherently', () => {
  const deps = (openaiKeyPresent: boolean) => ({
    resolveOpenAiPool: () =>
      openaiKeyPresent
        ? newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'openai:k', kind: 'api_key' as const, secret: 'sk' }] })
        : null,
    buildMcpResolver: buildOpenAiMcpResolver,
    buildToolManifest: buildOpenAiToolManifest,
  })

  test('unset / anthropic → {} (Claude Code, no provider override)', () => {
    expect(resolveOpenConversationalProvider({} as NodeJS.ProcessEnv, deps(false))).toEqual({})
    expect(
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'anthropic' } as unknown as NodeJS.ProcessEnv,
        deps(false),
      ),
    ).toEqual({})
  })

  test('openai + OPENAI_API_KEY → fully-wired GPT ctx', () => {
    const ctx = resolveOpenConversationalProvider(
      { NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv,
      deps(true),
    )
    expect(ctx.provider).toBe('openai')
    expect(ctx.openaiLlmPool).not.toBeNull()
    expect(ctx.openaiLlmPool).toBeDefined()
    expect(typeof ctx.bindMcpResolver).toBe('function')
    expect(typeof ctx.toolManifest).toBe('function')
  })

  test('openai WITHOUT a key → honored (provider set) so turns fail LOUD, NOT a silent Claude fallback', () => {
    const ctx = resolveOpenConversationalProvider(
      { NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv,
      deps(false),
    )
    expect(ctx.provider).toBe('openai')
    expect(ctx.openaiLlmPool).toBeUndefined() // no key → substrate fails loud per turn
  })

  test('typo like "openaii" (unknown value) → THROWS at the normalizer, NOT a silent {} Claude fallback', () => {
    expect(() =>
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openaii' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      ),
    ).toThrow(/Unknown model provider 'openaii'/)
    // Mutation check: must NOT silently return {} (Claude fallback) on a typo.
    let threw = false
    try {
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'garbage-value' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('openai-codex-cli (declared but NOT production-wired) → THROWS a loud boot error (never silent Claude)', () => {
    expect(() =>
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openai-codex-cli' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      ),
    ).toThrow(/not.*production-wired|refusing to boot/i)
    // Mutation check: it must NOT silently return {} (Claude fallback).
    let threw = false
    try {
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openai-codex-cli' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('wireSubstrates — pre-warm live reference', () => {
  test('prewarmReady never rejects and prewarmSettledRef flips true only after it resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const { ctx } = makeCtx({
      prewarmSubstrate: async (): Promise<void> => {
        await gate
      },
    })
    const w = wireSubstrates(ctx)
    expect(w.prewarmReady).not.toBeNull()
    // Not settled while the pre-warm is still in flight.
    expect(w.prewarmSettledRef.settled).toBe(false)
    // Never rejects.
    let rejected = false
    void w.prewarmReady!.catch(() => {
      rejected = true
    })
    release()
    await w.prewarmReady
    // The `.then` flipped the LIVE reference — the composer's cold-window read
    // now sees true.
    expect(w.prewarmSettledRef.settled).toBe(true)
    expect(rejected).toBe(false)
  })

  test('LLM-less: warm substrates null, prewarm skipped (settled true), factories throw', () => {
    const { ctx } = makeCtx({ llmPool: null })
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).toBeNull()
    expect(w.liveAgentSubstrate).toBeNull()
    // Compose is LLM-only — no provider → the per-project compose factory returns null.
    expect(w.makeComposeSubstrate('any-project')).toBeNull()
    expect(w.prewarmReady).toBeNull()
    // No pre-warm to await → settled seeds true immediately.
    expect(w.prewarmSettledRef.settled).toBe(true)
    expect(() => w.makeEphemeralSubstrate('cc-trident')('/repo')).toThrow(
      'cc-trident: empty Anthropic credential pool',
    )
    expect(() => w.makeWarmFireSubstrate('/repo')).toThrow(
      'cc-trident-fire: empty Anthropic credential pool',
    )
    expect(w.cleanups).toEqual([])
  })
})
