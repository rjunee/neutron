/**
 * Focused unit coverage for `open/wiring/landing.ts` (C3b carve).
 *
 * Runs `wireLandingStack` LLM-less over a real migrated `ProjectDb` + the repo
 * `landing/` static dir, and pins the CARE invariants the carve must preserve:
 *   - `importUseSynthesis: true` is forwarded VERBATIM — observable because
 *     `buildLandingStack` builds the accumulating-synthesis `importJobRunner`
 *     (non-null) ONLY when `importUseSynthesis === true` and no runner is
 *     injected. Drop the flag and `landing.importJobRunner` would be null.
 *   - the onboarding engine + chat surface are wired (`landing.engine`,
 *     `landing.fetch`).
 *   - the `chatAuthGate.isUnauthenticated` closure calls the threaded
 *     `resolveOpenLlmPool` against the LIVE `ctx.env` PER REQUEST — driven by a
 *     `GET /chat` against the raw landing surface with a spy resolver.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { newCredentialPool, type CredentialPool } from '@neutronai/runtime/credential-pool.ts'

function newPool(provider: string): CredentialPool {
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: `${provider}:k`, kind: 'api_key', secret: 'sk' }],
  })
}
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireLandingStack, type WireLandingStackDeps } from '../wiring/landing.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-wiring-landing-'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(
  env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv,
  overrides: Partial<OpenWiringContext> = {},
): OpenWiringContext {
  return {
    llmPool: null,
    internal_handle: 'owner',
    owner_home: tmpDir,
    project_slug: 'owner',
    env,
    db,
    prewarmSubstrate: async (): Promise<void> => {},
    ...overrides,
  }
}

/** Minimal LLM-less deps (every onboarding LLM hook omitted / null). */
function makeDeps(
  overrides: Partial<WireLandingStackDeps> = {},
): WireLandingStackDeps {
  return {
    installTokenHandler: async () => null,
    appWsButtonPromptRouter: {},
    appWsImportProgressRouter: {},
    static_dir: LANDING_DIR,
    platform: {} as PlatformAdapter,
    cookieToUserClaim: async () => null,
    resolveOpenLlmPool: (): CredentialPool | null => null,
    resolveOpenOpenAiPool: (): CredentialPool | null => null,
    phaseSpecResolver: null,
    personalityCharacterSuggester: undefined,
    personaSummarizer: undefined,
    projectOpeningComposer: undefined,
    importSubstrate: null,
    gbrainSyncHook: { onEntityWrite: async (): Promise<void> => {} },
    ...overrides,
  }
}

describe('wireLandingStack — synthesis opt-in + surface wiring', () => {
  test('forwards importUseSynthesis:true → landing.importJobRunner is non-null (accumulating synthesis runner)', () => {
    const { landing } = wireLandingStack(makeCtx(), makeDeps())
    // The synthesis runner is built ONLY when importUseSynthesis === true was
    // forwarded (no injected runner on the Open single-owner path).
    expect(landing.importJobRunner).not.toBeNull()
    // The onboarding engine + chat surface are wired.
    expect(landing.engine).toBeDefined()
    expect(typeof landing.fetch).toBe('function')
  })
})

describe('wireLandingStack — chatAuthGate closes over live env, evaluated per request', () => {
  test('GET /chat drives the threaded resolveOpenLlmPool against ctx.env each request', async () => {
    const seenEnv: Array<NodeJS.ProcessEnv> = []
    const env = { MARKER: 'live' } as unknown as NodeJS.ProcessEnv
    const resolveOpenLlmPool = (e: NodeJS.ProcessEnv): CredentialPool | null => {
      seenEnv.push(e)
      return null // unauthenticated → the gate must fire
    }
    const { landing } = wireLandingStack(makeCtx(env), makeDeps({ resolveOpenLlmPool }))
    // Raw landing.fetch (NOT wrapped by the composer's cookie-mint openFetch),
    // so GET /chat reaches the chatAuthGate check directly.
    const res = await landing.fetch(
      new Request('http://localhost/chat'),
      {} as never,
    )
    expect(res).toBeInstanceOf(Response)
    // The per-request closure fired against the SAME live env reference.
    expect(seenEnv.length).toBeGreaterThan(0)
    expect(seenEnv[0]).toBe(env)
  })

  test('provider=openai: auth gate keys on the OpenAI key, NOT the Claude key (audit Medium)', async () => {
    const claudeCalls: NodeJS.ProcessEnv[] = []
    const openaiCalls: NodeJS.ProcessEnv[] = []
    const claudePool = newPool('anthropic')
    // Claude key PRESENT, OpenAI key MISSING — under provider=openai this must
    // read UNAUTHENTICATED (every turn would fail for the missing OpenAI key), so
    // the gate must consult the OpenAI resolver and IGNORE the Claude one.
    const resolveOpenLlmPool = (e: NodeJS.ProcessEnv): CredentialPool | null => {
      claudeCalls.push(e)
      return claudePool
    }
    const resolveOpenOpenAiPool = (e: NodeJS.ProcessEnv): CredentialPool | null => {
      openaiCalls.push(e)
      return null
    }
    const env = { MARKER: 'openai-box' } as unknown as NodeJS.ProcessEnv
    const { landing } = wireLandingStack(
      makeCtx(env, { provider: 'openai' }),
      makeDeps({ resolveOpenLlmPool, resolveOpenOpenAiPool }),
    )
    await landing.fetch(new Request('http://localhost/chat'), {} as never)
    // Gate consulted the SELECTED provider's (OpenAI) resolver...
    expect(openaiCalls.length).toBeGreaterThan(0)
    // ...and did NOT let the present Claude key satisfy the gate.
    expect(claudeCalls.length).toBe(0)
  })

  test('provider=openai WITH an OpenAI key ⇒ gate authenticated (Claude resolver not consulted)', async () => {
    const claudeCalls: NodeJS.ProcessEnv[] = []
    const resolveOpenLlmPool = (e: NodeJS.ProcessEnv): CredentialPool | null => {
      claudeCalls.push(e)
      return null
    }
    const resolveOpenOpenAiPool = (): CredentialPool | null => newPool('openai')
    const { landing } = wireLandingStack(
      makeCtx({} as NodeJS.ProcessEnv, { provider: 'openai' }),
      makeDeps({ resolveOpenLlmPool, resolveOpenOpenAiPool }),
    )
    await landing.fetch(new Request('http://localhost/chat'), {} as never)
    expect(claudeCalls.length).toBe(0) // Claude resolver irrelevant under provider=openai
  })
})
