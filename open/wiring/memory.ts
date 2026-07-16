/**
 * @neutronai/open — scribe / GBrain / reflection wiring (C3a, carve #2).
 *
 * Behavior-preserving extraction of the memory slice of
 * `createOpenComposition` (old `open/composer.ts` lines 845-987): the dedicated
 * `cc-scribe-*` extraction substrate, the lazy fail-soft GBrain memory + its
 * `syncHook`, the `cc-reflection-*` correction-judge substrate + `reflection`,
 * the `scribeOnUserTurn` chat-bridge hook, and the Cores→scribe phase-2 fan-out.
 *
 * This slice is SELF-CONTAINED given the wiring context — it builds its own
 * `cc-scribe-*` / `cc-reflection-*` substrates directly and consumes NOTHING
 * that `wireSubstrates` produces, so it takes only `ctx`.
 *
 * Teardown hooks that were pushed inline onto the composer's `realmodeCleanups`
 * (the GBrain `close()` and the Cores fan-out `stop()`) are collected into the
 * returned `cleanups` array IN THE SAME ORDER; the composer appends them onto
 * `realmodeCleanups` at the carve site so SIGTERM ordering is byte-identical.
 */

import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import { buildGBrainMemory } from '@neutronai/gateway/wiring/build-gbrain-memory.ts'
import { createGbrainSyncStateStore } from '@neutronai/gateway/wiring/gbrain-sync-state-store.ts'
import { resolveOnboardingOpenAiKey } from '@neutronai/gateway/wiring/resolve-onboarding-openai-key.ts'
import { createScribe, type Scribe, type UserTurnInput } from '@neutronai/scribe/index.ts'
import { createState, defaultStatePath } from '@neutronai/scribe/scribe-budget.ts'
import {
  runReflectPass,
  DEFAULT_REFLECT_INTERVAL_MS,
  type ReflectPassDeps,
} from '@neutronai/scribe/index.ts'
import { writeEntity as defaultWriteEntity } from '@neutronai/runtime/entity-writer.ts'
import { SupervisedLoop } from '@neutronai/loop'
import { mountCoresScribeFanOut } from '@neutronai/gateway/cores/mount-cores-scribe-fan-out.ts'
import { createReflection, type Reflection } from '@neutronai/reflection/index.ts'
import { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import {
  emitNexusEvent,
  reflectionLearningEvent,
} from '@neutronai/gateway/nexus/nexus-emit.ts'
import { workBoardScopeKey } from '@neutronai/work-board/store.ts'
// The ONE canonical perfect-recall flag (RB lane). `gateway/nexus/nexus-emit.ts`
// re-exports THIS same predicate, so RC2 and RB1 read identical opt-in semantics
// off the same NEUTRON_PERFECT_RECALL var.
import { isPerfectRecallEnabled } from '@neutronai/runtime/perfect-recall-flag.ts'
import {
  wrapSyncHookWithMemoryIndex,
  type MemoryIndexWorkHandle,
} from '@neutronai/runtime/memory-index.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { OpenWiringContext } from './context.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface WiredMemory {
  /** Lazy fail-soft GBrain memory (scribe write target + `memory_search` store). */
  gbrainMemory: ReturnType<typeof buildGBrainMemory>
  /** The GBrain `syncHook` fanned to scribe, the page-indexer, and finalize. */
  gbrainSyncHook: ReturnType<typeof buildGBrainMemory>['syncHook']
  /** Chat-time entity extractor; null when LLM-less (no extraction substrate). */
  scribe: Scribe | null
  /** Diary + corrections-log self-improvement loop (always built). */
  reflection: Reflection
  /**
   * RB1 (perfect-recall) — cold-turn read of the breadth memory-index manifest,
   * with a synchronous regenerate-on-absent fallback (coalesced with the write
   * path). `undefined` when the perfect-recall flag is off. The composer wraps
   * the returned body as the `<memory_index>` injection fragment.
   */
  memoryIndexRead: (() => Promise<string | null>) | undefined
  /**
   * RB1 (perfect-recall) — LATE-BIND the active work-board handles provider. The
   * work-board store is constructed AFTER `wireMemory` in the composer, so the
   * regenerator holds a stable thunk that this setter fills in once the store
   * exists. Resolved fresh at each manifest generation (never a boot-time
   * snapshot). No-op when the flag is off.
   */
  setMemoryIndexWorkHandles: (provider: () => ReadonlyArray<MemoryIndexWorkHandle>) => void
  /** Fire-and-forget per-turn hook threaded into the chat-bridge; undefined LLM-less. */
  scribeOnUserTurn: ((input: UserTurnInput) => void) | undefined
  /**
   * RC2 — the shared agent-nexus store when the perfect-recall flag is on, else
   * null. Reflection's `learning` emitter is already wired onto it here; the
   * composer reuses THIS instance to build the trident harvest emitter so both
   * producers write through one store. Torn down via `cleanups`.
   */
  nexus: NexusStore | null
  /**
   * RB3 ([BEHAVIOR]) — the scheduled "reflect" consolidation loop, behind the
   * shared `NEUTRON_PERFECT_RECALL` flag. `null` when the flag is off (the
   * default) → the loop NEVER arms and NO LLM cost is ever incurred. When on, the
   * composer registers `describe()` into the LoopRegistry, `start()`s it, and
   * `stop()`s it on shutdown (register-before-start, quiescing stop). A
   * `SupervisedLoop` whose tick runs `runReflectPass` (dedup + re-synthesis +
   * reserved-kind extraction) once per `DEFAULT_REFLECT_INTERVAL_MS`.
   */
  reflectLoop: SupervisedLoop | null
  /** Teardown hooks (GBrain close, Cores fan-out stop) in registration order. */
  cleanups: Array<() => void>
}

/**
 * Construct the scribe / GBrain / reflection layer from the wiring context.
 * The composer appends the returned `cleanups` onto its `realmodeCleanups`.
 */
export function wireMemory(ctx: OpenWiringContext): WiredMemory {
  const { llmPool, substrateFactory, owner_handle, owner_home, project_slug, env, db } = ctx
  const cleanups: Array<() => void> = []

  // ── Scribe: chat-time entity extraction → GBrain (P0 daily-driver) ─────
  // gap-audit P0-3 / cat 7: the scribe package (`scribe/`) ships the whole
  // extract→GBrain path AND the chat-bridge fires `scribeOnUserTurn` after
  // every real user turn — but the param is OPTIONAL and the Open self-host
  // composer never threaded it, so chat-time extraction was DEAD in Open:
  // every person/company mention stayed a manual wiki entry. This wires it ON.
  //
  // A DEDICATED `cc-scribe-*` substrate (not the conversational `cc-agent-*`
  // one) keeps background extraction isolated from the live chat REPL — scribe
  // is a stateless one-shot caller (build-llm-call-substrate.ts names it
  // explicitly), so `ephemeral: true` gives per-extraction isolation on the
  // persistent substrate rather than accumulating extraction prompts into a
  // chat transcript. Gated on `llmPool` exactly like every other substrate:
  // LLM-less boxes have no extractor, so scribe stays off and the chat path is
  // unaffected (`scribeOnUserTurn` omitted → bridge no-ops).
  const scribeSubstrate =
    llmPool !== null
      ? buildLlmCallSubstrate({
          pool: llmPool,
          substrate_instance_id: `cc-scribe-${owner_handle}`,
          cwd: owner_home,
          owner_handle,
          user_id: OWNER_USER_ID,
          project_slug,
          skip_permissions: true,
          ephemeral: true,
          ...(substrateFactory !== undefined ? { substrateFactory } : {}),
        })
      : null

  // GBrain memory wiring is the scribe write target. `buildGBrainMemory` is
  // LAZY + FAIL-SOFT by contract: it emits ONE loud boot warning when the
  // `gbrain` binary is absent from PATH, then every memory op degrades to a
  // single latched failure (the entity page still lands on disk; only the
  // GBrain fan-out no-ops). So a missing/unresolvable GBrain NEVER crashes a
  // chat turn — it degrades with a clear log, exactly as the spec requires.
  // Built only when scribe can run (there is no point standing up a write
  // target with no extractor to feed it).
  // GBrain wiring is hoisted out of the scribe closure so the SAME syncHook
  // feeds three consumers: the chat-time scribe (below), the onboarding
  // materializer's project-page indexer (threaded into `buildLandingStack` as
  // `importGbrainSyncHook` so imported/onboarding projects land in MEMORY/
  // gbrain — previously unwired in Open), and the Path 1 onboarding finalize.
  // Lazy + fail-soft: building it never spawns `gbrain serve` until first use.
  //
  // ND1: activate GBrain semantic embeddings from the owner's onboarding-
  // captured OpenAI key (ApiKeyStore, provider=openai label=onboarding;
  // owner_handle == project_slug). When present, GBrain serves with
  // OpenAI `text-embedding-3-large`; absent → keyword + graph default.
  //
  // LAZY resolution (not an eager read here): this composition runs ONCE at
  // process boot, but the key is captured LATER — during onboarding / via the
  // admin Integrations surface, over the already-running server. An eager read
  // at boot would miss every freshly-pasted key until a restart (the bug:
  // "Openai embeddings key is supposed to be wired to Gbrain"). Threading a
  // resolver thunk instead defers the read to the FIRST `gbrain serve` spawn
  // (first memory op, after onboarding), so the key flips on embeddings at the
  // next turn — exactly what the onboarding offer promises. Best-effort: the
  // resolver swallows store errors and returns undefined (keyword + graph).
  // P9 — GBrain sync observability. The sole writer of `gbrain_sync_state`,
  // scoped to this project's brain (one brain per instance today). Threaded as
  // the hook's best-effort health sink so an operator can answer "is my memory
  // being written?". Pure side-observation: it never perturbs the fail-soft
  // sync path (the hook wraps every publish; the store also swallows its own
  // errors and uses a non-awaiting `runSync`).
  const gbrainSyncStateSink = createGbrainSyncStateStore({ db, scope: project_slug })
  const gbrainMemory = buildGBrainMemory({
    owner_home,
    project_slug,
    env,
    syncStateSink: gbrainSyncStateSink,
    resolveOpenAiKey: () =>
      resolveOnboardingOpenAiKey({ db, owner_home, owner_handle, project_slug }),
  })
  cleanups.push(() => {
    fireAndForget('memory.close', gbrainMemory.close())
  })
  // RB1 (perfect-recall lane, default-off flag) — when the flag is on, wrap the
  // gbrain syncHook so EVERY entity write (chat scribe, onboarding materializer,
  // Path-1 finalize — they all share this one hook) also regenerates the durable
  // breadth manifest at `entities/INDEX.md`. Backend-neutral: the wrapper reads
  // the portable entity pages, never gbrain, so it survives a memory-backend
  // swap. Coalesced + best-effort — a manifest failure is logged and never
  // disturbs the entity-write path. Off by default → the raw hook is threaded
  // unchanged (zero behavior change).
  // Late-bound active work-board handles provider (see WiredMemory.setMemory…).
  let workHandlesProvider: (() => ReadonlyArray<MemoryIndexWorkHandle>) | null = null
  const memoryIndexHook = isPerfectRecallEnabled(env)
    ? wrapSyncHookWithMemoryIndex(gbrainMemory.syncHook, owner_home, {
        logFailure: (err) =>
          fireAndForget(
            'memory.index',
            Promise.reject(err instanceof Error ? err : new Error(String(err))),
          ),
        workHandlesProvider: () => workHandlesProvider?.() ?? [],
      })
    : null
  const gbrainSyncHook = memoryIndexHook ?? gbrainMemory.syncHook
  // Bootstrap the manifest at boot when the flag is on, so a corpus that ALREADY
  // exists (entities written while the flag was off, then flipped on across a
  // restart) is advertised on the very next cold turn WITHOUT waiting for a new
  // entity write. Coalesced + best-effort — a no-op when there are no entities.
  if (memoryIndexHook !== null) memoryIndexHook.regenerate()
  const memoryIndexRead: (() => Promise<string | null>) | undefined =
    memoryIndexHook !== null ? () => memoryIndexHook.read() : undefined
  const setMemoryIndexWorkHandles = (
    provider: () => ReadonlyArray<MemoryIndexWorkHandle>,
  ): void => {
    workHandlesProvider = provider
  }
  const scribe: Scribe | null =
    scribeSubstrate !== null
      ? createScribe({
          substrate: scribeSubstrate,
          syncHook: gbrainSyncHook,
          ownerDataDir: owner_home,
          project_slug,
          budget: createState(defaultStatePath(owner_home)),
          // RB4 temporal invalidation (belief evolution) — dark behind the shared
          // perfect-recall flag. OFF → scribe stays pure-accretion (today's
          // behaviour); ON → a `supersedes` marker retires the stale
          // compiled-truth sentence + gbrain edge while the timeline keeps history.
          supersede: isPerfectRecallEnabled(env),
        })
      : null

  // ── Reflection: diary + corrections-log (P1 daily-driver, gap-audit §(c) #10) ──
  // The lightweight self-improvement loop COMPLEMENTING scribe/GBrain (which
  // capture entity knowledge). Two stores under the owner home:
  //   - diary/        — the agent's own append-only short reflections
  //   - corrections/  — owner corrections of the agent (what was wrong / right
  //                     / why), read back into context so future sessions adapt
  //                     SILENTLY (Vajra's corrections-log mechanism).
  // The correction JUDGE is an LLM call, so it gets its OWN dedicated ephemeral
  // `cc-reflection-*` substrate (per-judgement isolation, never pollutes the
  // chat REPL) — same shape as scribe's `cc-scribe-*`. When LLM-less the
  // substrate is omitted: detection is OFF but the diary + context read-back
  // still function, so the layer degrades gracefully.
  const reflectionSubstrate =
    llmPool !== null
      ? buildLlmCallSubstrate({
          pool: llmPool,
          substrate_instance_id: `cc-reflection-${owner_handle}`,
          cwd: owner_home,
          owner_handle,
          user_id: OWNER_USER_ID,
          project_slug,
          skip_permissions: true,
          ephemeral: true,
          ...(substrateFactory !== undefined ? { substrateFactory } : {}),
        })
      : null
  // RC2 ([BEHAVIOR]) — the agent-nexus emitter, behind the shared perfect-recall
  // flag (plan §14.6). When ON, a per-project append-only nexus sidecar receives
  // the owner's corrections as `learning` events (below) + the trident harvest's
  // handoff/decision events (wired on the trident input in the composer, over the
  // SAME store). When OFF, `nexus` is null → `createReflection` gets no emitter →
  // the `.nexus/` sidecar is never touched (unchanged behaviour). RC1's store is
  // cross-connection safe by design, so the composer reusing this one instance
  // for trident is a non-issue.
  const nexus = isPerfectRecallEnabled(env) ? new NexusStore({ owner_home }) : null
  if (nexus !== null) cleanups.push(() => nexus.closeAll())
  const reflection: Reflection = createReflection({
    ownerDataDir: owner_home,
    ...(reflectionSubstrate !== null ? { substrate: reflectionSubstrate } : {}),
    ...(nexus !== null
      ? {
          // Fire-and-forget: file the correction under the CANONICAL project
          // nexus scope. `scope` is `turn.project_id ?? 'general'`; run it
          // through `workBoardScopeKey` (owner boundary = `project_slug`) so it
          // matches the key trident stamps on a run's `project_slug`
          // (`workBoardScopeKey(project_slug, project_id)`) — General collapses
          // to the owner slug on BOTH sides, so a General correction and a
          // General trident decision land in the SAME `.nexus` a reader (RC3)
          // scopes to. A named project maps to its own id on both sides.
          emitLearning: ({ scope, correction }): void =>
            emitNexusEvent(
              nexus,
              workBoardScopeKey(project_slug, scope),
              reflectionLearningEvent(correction),
            ),
        }
      : {}),
  })

  // Production-shape hook threaded into `buildLandingStack` → the chat-bridge.
  // `scribe` is `const`, so TS preserves the `!== null` narrowing inside the
  // closure (the extraction is fire-and-forget; `handleUserTurn` returns void
  // and swallows its own errors — it never throws into the chat path).
  const scribeOnUserTurn: ((input: UserTurnInput) => void) | undefined =
    scribe !== null ? (input: UserTurnInput): void => scribe.handleUserTurn(input) : undefined

  // ── Cores→scribe phase-2 fan-out (Vajra parity gap #1) ─────────────────
  // The chat-turn extractor (`scribeOnUserTurn` above) is only HALF of scribe:
  // the phase-2 Cores→scribe fan-out lets the scheduled Calendar + Email Cores
  // contribute their OWN ambient extraction (today's events / inbox mail →
  // GBrain). That seam (`scribeFanOut` in `gateway/cores/{calendar,email-managed}
  // -wiring.ts`) was built but never threaded — its only callers were tests, so
  // per-Core memory extraction was DEAD. Mount it here so it runs on the live
  // single-owner Open boot path, gated on scribe being live (no extraction
  // target otherwise — LLM-less boxes are unaffected). Until a Google-backed
  // calendar/gmail client is composed in (separate parity gap), the in-memory
  // fallback clients yield an empty calendar/inbox, so the schedulers run
  // harmlessly and fan out nothing; the wire goes live with zero further
  // changes the moment a real client is supplied. Cleanup drains in-flight
  // extractions + tears the schedulers down at SIGTERM.
  if (scribe !== null) {
    const coresFanOut = mountCoresScribeFanOut({
      scribe,
      project_slug,
      owner_home,
    })
    cleanups.push(() => {
      fireAndForget('memory.stop', coresFanOut.stop())
    })
  }

  // ── RB3 ([BEHAVIOR]) — the scheduled "reflect" consolidation loop ──────────
  // The tiered-write autonomy uplift: deterministic work runs on every save
  // (Scribe/entity-writer, above — untouched), and the LLM-heavy consolidation
  // is confined to THIS scheduled batch. Behind the shared perfect-recall flag
  // so it NEVER arms — and spends ZERO tokens — by default. When on, a
  // `SupervisedLoop` runs `runReflectPass` (Jaccard dedup + timeline
  // re-synthesis + reserved meeting/project/original extraction) once per
  // `DEFAULT_REFLECT_INTERVAL_MS`. The composer registers/starts/stops it
  // (register-before-start; quiescing stop) exactly like the other loops.
  //
  // A DEDICATED ephemeral `cc-reflect-*` substrate isolates the batch LLM cost
  // from the chat REPL (same shape as `cc-scribe-*` / `cc-reflection-*`). Gated
  // on `llmPool`: an LLM-less box gets a dedup-only pass (no substrate → steps 2
  // and 3 are skipped), so the flag still degrades gracefully. `immediate:false`
  // means the first tick is one interval away — a flagged boot never fires an
  // LLM call synchronously at startup.
  let reflectLoop: SupervisedLoop | null = null
  if (isPerfectRecallEnabled(env)) {
    const reflectSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-reflect-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            ephemeral: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null
    const reflectDeps: ReflectPassDeps = {
      ownerDataDir: owner_home,
      ownSlug: project_slug,
      // Same cast the scribe path uses: the real writer satisfies the minimal
      // `WriteEntityFn` surface (an extra optional field on the input is fine).
      writeEntity: defaultWriteEntity as unknown as ReflectPassDeps['writeEntity'],
      syncHook: gbrainSyncHook,
      // Best-effort brain-side removal of a merged-away loser page, through the
      // backend-neutral `MemoryStore.delete` seam (no gbrain internals leak here).
      deletePage: (slug: string): Promise<void> =>
        gbrainMemory.memoryStore.delete({ id: slug }).then(() => undefined),
      ...(reflectSubstrate !== null ? { substrate: reflectSubstrate } : {}),
    }
    reflectLoop = new SupervisedLoop({
      name: 'reflect-consolidation',
      intervalMs: DEFAULT_REFLECT_INTERVAL_MS,
      tick: async (): Promise<void> => {
        await runReflectPass(reflectDeps)
      },
    })
    // NOTE: register/start/stop is owned by the composer (it holds the
    // LoopRegistry + realmode cleanups), matching the lifecycle-watchdog pattern.
  }

  return {
    gbrainMemory,
    gbrainSyncHook,
    scribe,
    reflection,
    scribeOnUserTurn,
    nexus,
    memoryIndexRead,
    setMemoryIndexWorkHandles,
    reflectLoop,
    cleanups,
  }
}
