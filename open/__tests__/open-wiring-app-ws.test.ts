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
 *   - `tridentDeliverySink.send` no-ops (returns '') for a non-app_socket
 *     message and forwards to the bound adapter for an app_socket one;
 *   - `cleanups` is collected as an array.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { ChatCommandFilter } from '@neutronai/contracts/chat-command-filter.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import type { AppSocketButtonPromptRouter, AppSocketImportProgressRouter } from '@neutronai/gateway/http/chat-bridge.ts'
import type { OutgoingMessage } from '@neutronai/channels/types.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { late } from '../wiring/late.ts'
import { wireAppWs, type OnboardingMsgEmit } from '../wiring/app-ws.ts'
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
    internal_handle: 'owner',
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

  test('tridentDeliverySink: no-op on non-app_socket, forwards to bound adapter on app_socket', async () => {
    const { deps } = buildDeps()
    const wired = wireAppWs(buildCtx(), deps)

    const webMsg = {
      topic: { topic_id: '', channel_kind: 'web' as const, channel_topic_id: 't', project_id: null, privacy_mode: 'regular' as const },
      text: 'hi',
    } as unknown as OutgoingMessage
    expect(await wired.tridentDeliverySink.send(webMsg)).toBe('')

    const appMsg = {
      topic: { topic_id: '', channel_kind: 'app_socket' as const, channel_topic_id: 'app:owner', project_id: null, privacy_mode: 'regular' as const },
      text: 'done',
    } as unknown as OutgoingMessage
    // Bound adapter (no live socket) → app-ws:dropped id string; the point is it
    // routes through the adapter rather than no-op'ing.
    const id = await wired.tridentDeliverySink.send(appMsg)
    expect(typeof id).toBe('string')
    expect(id.startsWith('app-ws:')).toBe(true)
  })
})
