/**
 * Focused unit test for `wireAppWs` (C3d, carve #6).
 *
 * Boots the wiring in isolation with fake deps and asserts the STRUCTURE the
 * carve must preserve:
 *   - the app-ws adapter is constructed + the `appWs` late<T> seam is BOUND;
 *   - `appWsSurface` (handler + websocket) is returned;
 *   - the delivery translators are wired: `onboardingMsg` bound, the engine
 *     button-prompt + import-progress routers' `.send` set, the clarifying
 *     poster's `.post` set;
 *   - X5: `channelRouter` has the durable app-ws adapter registered for
 *     `app_socket`; `router.send` forwards an app_socket message to the adapter
 *     (the activated trident-delivery seam) and THROWS loud for an unregistered
 *     kind (no silent drop);
 *   - `cleanups` is collected as an array.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { readOwnerTimezone } from '@neutronai/gateway/storage/owner-metadata.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { ChatCommandFilter } from '@neutronai/contracts/chat-command-filter.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/wiring/build-landing-stack.ts'
import type { AppSocketButtonPromptRouter, AppSocketImportProgressRouter } from '@neutronai/gateway/http/chat-bridge.ts'
import type { OutgoingMessage } from '@neutronai/channels/types.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { late } from '../wiring/late.ts'
import {
  MAX_INBOUND_ATTACHMENTS,
  sanitizeInboundAttachments,
  wireAppWs,
  type OnboardingMsgEmit,
} from '../wiring/app-ws.ts'
import type { OpenComposition } from '../composer.ts'

// ── C3d compile-level assertion: `OpenComposition`'s required-pick makes every
// UNCONDITIONALLY-set surface non-optional, so a return literal that DROPS one is
// a tsc error (a dropped slice fails the BUILD, not a runtime 404). Proven at the
// type level: for a required key K, `undefined extends OpenComposition[K]` is
// false; for a CONDITIONALLY-omitted surface (e.g. `trident`) it stays optional,
// so it is NOT forced required (which would break an LLM-less boot).
type _AppDocsIsRequired = undefined extends OpenComposition['app_docs_surface'] ? false : true
const _appDocsRequired: _AppDocsIsRequired = true
type _TridentStaysOptional = undefined extends OpenComposition['trident'] ? true : false
const _tridentOptional: _TridentStaysOptional = true
// @ts-expect-error — `app_ws_surface` is required, so dropping it (here: assigning
// a value whose type omits it) is a COMPILE error. This line MUST error; if the
// required-pick ever loses `app_ws_surface`, `@ts-expect-error` goes unused → red.
const _dropped: OpenComposition = {} as Omit<OpenComposition, 'app_ws_surface'>
void _appDocsRequired
void _tridentOptional
void _dropped

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-wire-appws-'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function buildCtx(): OpenWiringContext {
  return {
    llmPool: null,
    owner_handle: 'owner',
    owner_home: tmpDir,
    project_slug: 'owner',
    env: {},
    db,
    prewarmSubstrate: async () => {},
  }
}

function buildDeps() {
  const appWs = late<AppWsAdapter>('test-app-ws')
  const onboardingMsg = late<OnboardingMsgEmit>('test-onboarding-msg')
  const appWsButtonPromptRouter: AppSocketButtonPromptRouter = {}
  const appWsImportProgressRouter: AppSocketImportProgressRouter = {}
  const buildClarifyPoster: { post?: (chatId: string, text: string) => void } = {}
  const importWatchHolder: { watch?: (user_id: string) => void } = {}
  const sendReplyCalls: Array<{ topic: string; project_id: string | undefined }> = []
  const deps = {
    appWs,
    buildAppWsSendReply:
      (channel_topic_id: string, project_id?: string) =>
      (): void => {
        sendReplyCalls.push({ topic: channel_topic_id, project_id })
      },
    onboardingMsg,
    importWatchHolder,
    appWsButtonPromptRouter,
    appWsImportProgressRouter,
    buildClarifyPoster,
    appWsRegistry: new InMemoryAppWsSessionRegistry(),
    appWsChatTurn: null,
    scribeOnUserTurn: undefined,
    chatCommandFilter: { match: async () => null } as ChatCommandFilter,
    appOwnerAuth: {
      mode: 'dev-bypass',
      resolve: async () => ({ ok: true as const, user_id: 'owner' }),
    } as unknown as AppWsAuthResolver,
    appWsToken: 'nbt_test_token',
    bindIsLoopback: true,
    landing: {
      stateStore: { get: async () => null },
      buttonStore: { emit: async () => ({ prompt_id: 'p', was_new: true }), latestTurnByTopic: async () => null },
    } as unknown as LandingStackWithEngine,
    emitProjectsChangedIfChanged: () => {},
    buildProjectsChangedFrame: () => ({
      v: 1 as const,
      type: 'projects_changed' as const,
      ts: 0,
      projects: [],
      active_project_id: null,
    }),
    isOnboardingActive: async () => false,
    finalizeImportOnboardingIfReady: async () => false,
    readProjectRows: () => [],
    activeChatProjects: new Set<string>(),
    railChatKey: (project_id?: string) => project_id ?? 'general',
  }
  return { deps, appWs, onboardingMsg, appWsButtonPromptRouter, appWsImportProgressRouter, buildClarifyPoster }
}

/**
 * O6 — a synthetic `ServerWebSocket` just complete enough to drive the surface's
 * `open()` path (which fires `on_session_open`, where the recovered-reply drain is
 * wired). `send` returns a non-zero write count so the surface treats the socket
 * as live.
 */
function fakeOpenWs(channel_topic_id: string): Parameters<
  NonNullable<ReturnType<typeof wireAppWs>['appWsSurface']['websocket']['open']>
>[0] {
  return {
    data: { surface: 'app_ws', user_id: 'owner', project_slug: 'owner', channel_topic_id },
    send: () => 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

// Argus r2 #4 — the inbound attachment list is client-supplied; each survivor
// drives a downstream existsSync + <user_attachments> prompt line, so it must be
// deduped and bounded.
describe('sanitizeInboundAttachments', () => {
  test('keeps only non-empty strings', () => {
    expect(
      sanitizeInboundAttachments([
        '/api/app/upload/sam/a.png',
        '',
        42,
        null,
        undefined,
        { url: 'x' },
      ]),
    ).toEqual(['/api/app/upload/sam/a.png'])
  })

  test('is empty for a non-array', () => {
    expect(sanitizeInboundAttachments(undefined)).toEqual([])
    expect(sanitizeInboundAttachments('nope')).toEqual([])
    expect(sanitizeInboundAttachments(null)).toEqual([])
  })

  test('dedups repeated URLs (same blob injected once)', () => {
    expect(
      sanitizeInboundAttachments([
        '/api/app/upload/sam/a.png',
        '/api/app/upload/sam/a.png',
        '/api/app/upload/sam/b.pdf',
      ]),
    ).toEqual(['/api/app/upload/sam/a.png', '/api/app/upload/sam/b.pdf'])
  })

  test(`caps at MAX_INBOUND_ATTACHMENTS (${MAX_INBOUND_ATTACHMENTS})`, () => {
    const many = Array.from({ length: MAX_INBOUND_ATTACHMENTS + 20 }, (_, i) => `/api/app/upload/sam/${i}.png`)
    const out = sanitizeInboundAttachments(many)
    expect(out.length).toBe(MAX_INBOUND_ATTACHMENTS)
    expect(out[0]).toBe('/api/app/upload/sam/0.png')
  })
})

// M2 task 5 — the voice-note transcript must reach the SCRIBE text (voice →
// text → gbrain parity) via the `attachmentTranscript` seam, WITHOUT mutating
// the turn's user_text. Driven through the real adapter `dispatchInbound` seam
// so the production receiver path runs.
describe('wireAppWs — voice-note transcript threads into scribe (task 5)', () => {
  const AUDIO_URL = '/api/app/upload/owner/beefbeefbeefbeef.wav'

  function buildScribeDeps(over: {
    attachmentTranscript?: (url: string) => string | null
  }) {
    const { deps } = buildDeps()
    const scribeCalls: Array<{ text: string }> = []
    const turnCalls: Array<{ user_text: string }> = []
    const merged = {
      ...deps,
      // A live (non-null) turn runner so the receiver reaches the scribe call.
      appWsChatTurn: async (turn: { user_text: string }) => {
        turnCalls.push({ user_text: turn.user_text })
        return {} as unknown
      },
      scribeOnUserTurn: (input: { text: string }) => {
        scribeCalls.push({ text: input.text })
      },
      ...(over.attachmentTranscript !== undefined
        ? { attachmentTranscript: over.attachmentTranscript }
        : {}),
    } as unknown as Parameters<typeof wireAppWs>[1]
    return { deps: merged, scribeCalls, turnCalls }
  }

  test('the transcript seam enriches the scribe text (placeholder + transcript), user_text unmutated', async () => {
    const { deps, scribeCalls, turnCalls } = buildScribeDeps({
      attachmentTranscript: (url) => (url === AUDIO_URL ? 'voice text' : null),
    })
    const wired = wireAppWs(buildCtx(), deps)
    await wired.appWsSurface.adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: 'app:owner',
      body: '', // attachment-only → placeholder 'Sent an attachment.'
      attachments: [AUDIO_URL],
    })
    // Fire-and-forget scribe — give it a tick to settle.
    await new Promise((r) => setTimeout(r, 5))
    expect(scribeCalls.length).toBe(1)
    expect(scribeCalls[0]!.text).toContain('Sent an attachment.')
    expect(scribeCalls[0]!.text).toContain('voice text')
    // The turn's user_text is NEVER mutated — it stays the placeholder.
    expect(turnCalls[0]!.user_text).toBe('Sent an attachment.')
  })

  test('seam undefined → scribe text is exactly the user text (regression pin)', async () => {
    const { deps, scribeCalls } = buildScribeDeps({}) // no attachmentTranscript
    const wired = wireAppWs(buildCtx(), deps)
    await wired.appWsSurface.adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: 'app:owner',
      body: 'just typed text',
      attachments: [AUDIO_URL],
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(scribeCalls.length).toBe(1)
    expect(scribeCalls[0]!.text).toBe('just typed text')
  })
})

describe('wireAppWs (C3d carve #6)', () => {
  test('constructs the adapter, binds the appWs seam, and returns the surface', () => {
    const { deps, appWs } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    // The adapter was constructed and the late<T> seam bound to it.
    expect(appWs.isBound()).toBe(true)
    expect(appWs.get()).toBeInstanceOf(AppWsAdapter)

    // The surface is returned with a handler + websocket + adapter.
    expect(typeof wired.appWsSurface.handler).toBe('function')
    expect(wired.appWsSurface.websocket).toBeDefined()
    expect(wired.appWsSurface.adapter).toBe(appWs.get()!)

    // Cleanups are collected as an array (re-registered at the carve site).
    expect(Array.isArray(wired.cleanups)).toBe(true)
  })

  test('wires the delivery translators (onboardingMsg bind + router/poster binds)', () => {
    const { deps, onboardingMsg, appWsButtonPromptRouter, appWsImportProgressRouter, buildClarifyPoster } =
      buildDeps()
    wireAppWs(buildCtx(), deps)

    expect(onboardingMsg.isBound()).toBe(true)
    expect(typeof appWsButtonPromptRouter.send).toBe('function')
    expect(typeof appWsImportProgressRouter.send).toBe('function')
    expect(typeof buildClarifyPoster.post).toBe('function')
  })

  test('X5: channelRouter has the app-ws adapter registered for app_socket', () => {
    const { deps, appWs } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    // The returned router IS the one delivery seam: the durable app-ws adapter
    // (the SAME instance bound to the late<T>) is registered for `app_socket`.
    expect(wired.channelRouter.getAdapter('app_socket')).toBe(appWs.get()!)
    // Boot-conformance guard passes for the kind Open runs carry (it ran inside
    // wireAppWs — this just re-asserts it doesn't throw).
    expect(() => wired.channelRouter.assertAdaptersFor(['app_socket'])).not.toThrow()
  })

  test('X5: channelRouter.send routes app_socket to the adapter (trident delivery seam)', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    const appMsg: OutgoingMessage = {
      topic: {
        topic_id: '',
        channel_kind: 'app_socket',
        channel_topic_id: 'app:owner',
        project_id: null,
        privacy_mode: 'regular',
      },
      text: 'done',
    }
    // Bound adapter (no live socket) → `app-ws:dropped:<id>`; the point is
    // `router.send` dispatches to the app-ws adapter — the activated seam trident
    // terminal delivery + the board terminator now post through.
    const id = await wired.channelRouter.send(appMsg)
    expect(typeof id).toBe('string')
    expect(id.startsWith('app-ws:')).toBe(true)
  })

  test('X5: channelRouter.send THROWS loud for an unregistered kind (no silent drop)', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    const tgMsg: OutgoingMessage = {
      topic: {
        topic_id: '',
        channel_kind: 'telegram',
        channel_topic_id: '123',
        project_id: null,
        privacy_mode: 'regular',
      },
      text: 'unreachable on Open',
    }
    // Open registers no Telegram adapter; a stray non-app_socket send fails loud
    // rather than silently vanishing. In production both trident terminal entry
    // points (tick-loop `on_terminal` + the out-of-band terminator) wrap this in
    // try/catch, and every Open run is stamped `app_socket`, so this path is
    // unreachable — but the seam is fail-loud by design.
    await expect(wired.channelRouter.send(tgMsg)).rejects.toThrow(/no channel adapter registered/)
  })
})

describe('wireAppWs — recovered-reply drain on reconnect (O6)', () => {
  test('on_session_open drains any recovered replies for the CONNECTED topic', async () => {
    const { deps } = buildDeps()
    const drained: string[] = []
    const wired = wireAppWs(buildCtx(), { ...deps, recoveredReplyDrain: (t: string) => drained.push(t) })

    // Driving the surface's open() runs on_session_open — where app-ws.ts wires the
    // drain (the offline-buffered replies re-emit on the next connect).
    await wired.appWsSurface.websocket.open!(fakeOpenWs('app:owner'))

    expect(drained).toEqual(['app:owner'])
  })

  test('drains on reconnect EVEN with onboarding active (the drain precedes the onboarding branch)', async () => {
    const { deps } = buildDeps()
    const drained: string[] = []
    const wired = wireAppWs(buildCtx(), {
      ...deps,
      isOnboardingActive: async () => true,
      recoveredReplyDrain: (t: string) => drained.push(t),
    })

    await wired.appWsSurface.websocket.open!(fakeOpenWs('app:owner'))

    expect(drained).toEqual(['app:owner'])
  })

  test('no drain wired (LLM-less boot) → open() is a clean no-op', async () => {
    const { deps } = buildDeps() // no recoveredReplyDrain
    const wired = wireAppWs(buildCtx(), deps)

    // The `recoveredReplyDrain?.(…)` optional call must not throw when omitted.
    await expect(wired.appWsSurface.websocket.open!(fakeOpenWs('app:owner'))).resolves.toBeUndefined()
  })
})

/**
 * ISSUES #40 — the PRODUCTION owner-timezone WRITE path exercised end-to-end
 * through the REAL `wireAppWs` seam: the composer binds `on_client_timezone` to
 * `persistOwnerTimezoneIfChanged(db, project_slug, tz)`, and the app-ws surface
 * fires it in `open()` from the socket's captured `tz`. These drive that exact
 * wiring against the migrated project.db, so the #378 `readOwnerTimezone`
 * consumer resolves the persisted zone.
 *
 * Mutation-kill: DELETING `on_client_timezone` from `wireAppWs` (or dropping the
 * `data.tz` fire in the surface) makes the persisted-zone assertions go red —
 * unlike the surface-level test (own recorder) or the direct-persist round-trip,
 * this is the only test that fails if the production seam is unwired.
 */
describe('wireAppWs — owner-timezone persistence (ISSUES #40, production seam)', () => {
  /** Open the wired surface with a socket that reports `tz` (or none) for a
   *  given channel `user_id` (defaults to the instance OWNER). */
  async function openWithTz(
    wired: ReturnType<typeof wireAppWs>,
    tz: string | undefined,
    user_id = 'owner',
  ): Promise<void> {
    const data: Record<string, unknown> = {
      surface: 'app_ws',
      user_id,
      project_slug: 'owner',
      channel_topic_id: `app:${user_id}`,
    }
    if (tz !== undefined) data.tz = tz
    await wired.appWsSurface.websocket.open!(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data, send: () => 1 } as any,
    )
  }

  /** The write is fire-and-forget; poll until it lands (or a bounded timeout). */
  async function waitForZone(expected: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (readOwnerTimezone(db, 'owner') === expected) return
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  /** Let any pending fire-and-forget settle (for negative/no-write assertions). */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 30))
  }

  test('the OWNER reporting a zone persists it via the real wiring → readOwnerTimezone resolves it', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)
    expect(readOwnerTimezone(db, 'owner')).toBeNull()

    // user_id defaults to the instance OWNER ('owner' === OWNER_USER_ID).
    await openWithTz(wired, 'America/New_York')
    await waitForZone('America/New_York')
    expect(readOwnerTimezone(db, 'owner')).toBe('America/New_York')
  })

  test('AUTHORIZATION: a NON-owner user_id reporting a zone is REJECTED — the owner tz is NOT written', async () => {
    // The app-ws auth resolver binds many user_ids to the same instance
    // project_slug (shared-project guests / other device identities). A guest
    // must NOT be able to rewrite the OWNER's timezone (it drives the owner's
    // nudges). The wiring gates on `user_id === OWNER_USER_ID` and silently
    // ignores others. Mutation-kill: DELETING that gate lets this guest write
    // land, flipping the assertion below red.
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)
    expect(readOwnerTimezone(db, 'owner')).toBeNull()

    await openWithTz(wired, 'Asia/Singapore', 'guest-not-owner')
    await settle()
    // The owner's stored timezone is UNCHANGED (still absent).
    expect(readOwnerTimezone(db, 'owner')).toBeNull()
  })

  test('AUTHORIZATION: a non-owner cannot OVERWRITE the owner-set zone', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)
    // Owner sets NYC first.
    await openWithTz(wired, 'America/New_York')
    await waitForZone('America/New_York')
    // A guest then reports a different zone — it must be ignored, NYC stands.
    await openWithTz(wired, 'Asia/Singapore', 'guest-not-owner')
    await settle()
    expect(readOwnerTimezone(db, 'owner')).toBe('America/New_York')
  })

  test('no reported zone → nothing is written (absent boundary)', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    await openWithTz(wired, undefined)
    await settle()
    expect(readOwnerTimezone(db, 'owner')).toBeNull()
  })

  test('a garbage (IANA-shaped but unknown) zone is rejected → nothing written (invalid boundary)', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    await openWithTz(wired, 'Foo/Bar')
    await settle()
    expect(readOwnerTimezone(db, 'owner')).toBeNull()
  })

  test('an unchanged zone on reconnect stays put (unchanged boundary) and a genuine change updates it', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    await openWithTz(wired, 'America/New_York')
    await waitForZone('America/New_York')
    // Reconnect reporting the SAME zone — idempotent, still NYC.
    await openWithTz(wired, 'America/New_York')
    await settle()
    expect(readOwnerTimezone(db, 'owner')).toBe('America/New_York')
    // A genuine change is honored on the next connect.
    await openWithTz(wired, 'Asia/Singapore')
    await waitForZone('Asia/Singapore')
    expect(readOwnerTimezone(db, 'owner')).toBe('Asia/Singapore')
  })
})
