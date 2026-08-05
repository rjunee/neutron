/**
 * @neutronai/app — voice-transcription wire-shape mirror-parity test (ISSUES #498).
 *
 * `app/lib/voice-transcription-client.ts` and
 * `landing/chat-react/voice-transcription-client.ts` hand-declare the SAME wire
 * shapes for `/api/app/voice-transcription`, so the Metro bundle carries no
 * dependency on the browser package (the rule every app client follows). The
 * app-side docblock told readers this duplication was "held honest mechanically
 * by `__tests__/voice-transcription-mirror-parity.test.ts`" — this file. It did
 * not exist. The types were unguarded, and the sentence suppressed the very
 * check it promised. This is that file; the sentence is now true.
 *
 * TWO SIDES, NOT THREE. `tab-descriptor-mirror-parity.test.ts` pins its two
 * mirrors against a third leg, the engine's own `tabs/registry.ts` declaration.
 * There is no third leg here: `buildStatus()` in
 * `gateway/http/voice-transcription-surface.ts:104` is declared
 * `Promise<object>`, so the server has NO type for the shape it sends. The two
 * clients are pinned to each other, and that is the whole of what exists to pin.
 *
 * The mechanism is the one those two tests already use — deliberately, because
 * a codebase with two parity idioms is worse than one with none:
 *
 *   1. COMPILE-TIME exactness. `tsc --noEmit` (run over `app/tsconfig.json` by
 *      `scripts/ci/typecheck-all.sh`, which includes this directory) is the
 *      guard that actually reds on drift — `bun test` does not typecheck, so a
 *      drifted declaration is caught by the typecheck job, not the test job.
 *      Two shapes of assertion, both already in this repo:
 *        - Bidirectional structural assignment through a value typed as one
 *          side and assigned to the other and back
 *          (`tab-descriptor-mirror-parity.test.ts:67-68`).
 *        - `never`-guarded difference assertions
 *          (`agent-engagement-mode-mirror-parity.test.ts:73`), which close the
 *          gap bidirectional assignment leaves: width subtyping happily accepts
 *          an OPTIONAL field or an extra key present on one side only, so
 *          assignment alone would not red on it. `Drift<A, B>` collapses to
 *          `never` exactly when the two agree, and a `never` parameter cannot
 *          receive a live member.
 *   2. RUNTIME backstop. Two fully-populated samples, each pinned to its own
 *      side's type — so each literal is excess-property-checked against its own
 *      declaration — asserted deep-equal to one another, and both clients'
 *      private `normalizeStatus` copies driven over the same server payloads
 *      and asserted to produce the same object. That last one catches drift the
 *      type check cannot see at all: the two files each carry their own copy of
 *      the old-server defaulting logic.
 *
 * Today the two declarations agree exactly — this test characterizes that
 * agreement, not a fix.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  VoiceTranscriptionClient,
  VoiceTranscriptionClientError as AppVoiceTranscriptionClientError,
  type NoTranscriberReason as AppNoTranscriberReason,
  type OpenAiKeySource as AppOpenAiKeySource,
  type OpenAiKeyStatus as AppOpenAiKeyStatus,
  type TranscriptionBackend as AppTranscriptionBackend,
  type TranscriptionBackendChoice as AppTranscriptionBackendChoice,
  type VoiceTranscriptionClientOptions as AppVoiceTranscriptionClientOptions,
  type VoiceTranscriptionStatus as AppVoiceTranscriptionStatus,
  type WhisperInstallPhase as AppWhisperInstallPhase,
  type WhisperJob as AppWhisperJob,
  type WhisperModelOption as AppWhisperModelOption,
} from '../lib/voice-transcription-client'

import {
  WebVoiceTranscriptionClient,
  VoiceTranscriptionClientError as WebVoiceTranscriptionClientError,
  type NoTranscriberReason as WebNoTranscriberReason,
  type OpenAiKeySource as WebOpenAiKeySource,
  type OpenAiKeyStatus as WebOpenAiKeyStatus,
  type TranscriptionBackend as WebTranscriptionBackend,
  type TranscriptionBackendChoice as WebTranscriptionBackendChoice,
  type VoiceTranscriptionClientOptions as WebVoiceTranscriptionClientOptions,
  type VoiceTranscriptionStatus as WebVoiceTranscriptionStatus,
  type WhisperInstallPhase as WebWhisperInstallPhase,
  type WhisperJob as WebWhisperJob,
  type WhisperModelOption as WebWhisperModelOption,
} from '@neutronai/landing/chat-react/voice-transcription-client'

// ── Compile-time difference assertions ──────────────────────────────────
// Pure type-level checks: their VALUE is irrelevant, the fact that they
// typecheck is the guardrail. `Drift` is `never` exactly when the two sides
// agree; a member or key present on ONE side only survives into it, and a
// parameter declared `never` cannot then be returned as `never`.

/** `never` iff `A` and `B` have exactly the same members. */
type Drift<A, B> = Exclude<A, B> | Exclude<B, A>

// Literal unions — a member added to, removed from, or renamed on either side.
const _driftBackend = (v: Drift<AppTranscriptionBackend, WebTranscriptionBackend>): never => v
const _driftChoice = (
  v: Drift<AppTranscriptionBackendChoice, WebTranscriptionBackendChoice>,
): never => v
const _driftReason = (v: Drift<AppNoTranscriberReason, WebNoTranscriberReason>): never => v
const _driftKeySource = (v: Drift<AppOpenAiKeySource, WebOpenAiKeySource>): never => v
const _driftPhase = (v: Drift<AppWhisperInstallPhase, WebWhisperInstallPhase>): never => v

// Interfaces — a FIELD added to, removed from, or renamed on either side,
// INCLUDING an optional one, which bidirectional assignment below would let
// through (width subtyping accepts an extra property on a non-fresh value).
const _driftModelKeys = (
  k: Drift<keyof AppWhisperModelOption, keyof WebWhisperModelOption>,
): never => k
const _driftJobKeys = (k: Drift<keyof AppWhisperJob, keyof WebWhisperJob>): never => k
const _driftKeyStatusKeys = (
  k: Drift<keyof AppOpenAiKeyStatus, keyof WebOpenAiKeyStatus>,
): never => k
const _driftStatusKeys = (
  k: Drift<keyof AppVoiceTranscriptionStatus, keyof WebVoiceTranscriptionStatus>,
): never => k

// Construction options — this is what pins the web client's REQUEST TIMEOUT.
// It had none while the app had 15s (ISSUES #503), so a `timeoutMs` dropped
// from either side reds here.
const _driftOptionsKeys = (
  k: Drift<keyof AppVoiceTranscriptionClientOptions, keyof WebVoiceTranscriptionClientOptions>,
): never => k

/**
 * The guarantee above is entirely compile-time — a `never` parameter has no
 * value to pass, so these cannot be called. Collected so they are not dead
 * code, and so a reader who greps for one of them lands somewhere that says
 * what they are for.
 */
const DRIFT_GUARDS = [
  _driftBackend,
  _driftChoice,
  _driftReason,
  _driftKeySource,
  _driftPhase,
  _driftModelKeys,
  _driftJobKeys,
  _driftKeyStatusKeys,
  _driftStatusKeys,
  _driftOptionsKeys,
] as const

// ── Constructor-shape drift guards (ISSUES #503) ────────────────────────
//
// The guards above pin the shapes that go over the WIRE. A constructor is not
// one of them, so `VoiceTranscriptionClientError` was free to take
// `(status, code, message)` on the app side and `(code, message, status)` on
// the web side — two near-identical files, each internally consistent, each
// reading plausibly. Nothing red. A construction copied from one file to the
// other produced a silently wrong error object: a status where a code belongs.
//
// `ConstructorParameters<typeof C>` is the parameter list as a TUPLE, and tuple
// assignment is ELEMENT-WISE and POSITIONAL. Asserting it both ways pins the
// parameter types AND their order. These are ordinary (callable) functions
// rather than `never`-parameter ones because the guarantee here is the
// ASSIGNMENT in the return position, not an uninhabited parameter.
type AppErrCtorArgs = ConstructorParameters<typeof AppVoiceTranscriptionClientError>
type WebErrCtorArgs = ConstructorParameters<typeof WebVoiceTranscriptionClientError>

const _driftErrCtorAppToWeb = (a: AppErrCtorArgs): WebErrCtorArgs => a
const _driftErrCtorWebToApp = (w: WebErrCtorArgs): AppErrCtorArgs => w

// The FIELDS the constructor populates, pinned separately: a side that renamed
// `code`, or retyped `status` to a string, would keep an assignable parameter
// tuple while changing what a `catch` block reads. `name` is deliberately
// excluded — the app declares it as a literal type and the web as `string`, a
// difference with no consequence for a caller, asserted at runtime below.
type AppErrFields = Pick<AppVoiceTranscriptionClientError, 'code' | 'status' | 'message'>
type WebErrFields = Pick<WebVoiceTranscriptionClientError, 'code' | 'status' | 'message'>

const _driftErrFieldsAppToWeb = (a: AppErrFields): WebErrFields => a
const _driftErrFieldsWebToApp = (w: WebErrFields): AppErrFields => w

/**
 * Collected for the same reason as `DRIFT_GUARDS`: so they are not dead code,
 * and so the count can be pinned against silent deletion.
 *
 * These CANNOT close the case on their own, and the runtime tests below are not
 * belt-and-braces. Two blind spots, both real:
 *   1. `tsc` compares parameter TYPES, never parameter NAMES. A future
 *      `(code, message)` vs `(message, code)` swap — both `string` — produces
 *      identical tuples and passes here. The source-text guard covers that.
 *   2. `bun test` does not typecheck at all, so on the test job these are inert
 *      and only the behavioural assertions run.
 */
const CONSTRUCTOR_SHAPE_GUARDS = [
  _driftErrCtorAppToWeb,
  _driftErrCtorWebToApp,
  _driftErrFieldsAppToWeb,
  _driftErrFieldsWebToApp,
] as const

// ── Exhaustive runtime enumerations ─────────────────────────────────────
// `Record<Union, true>` is exhaustive BY CONSTRUCTION: a member missing from
// the literal is a missing-property error, a member the union lacks is an
// excess-property error. So these lists cannot silently fall behind the type.

const BACKENDS: Record<AppTranscriptionBackend, true> = { local: true, openai: true, none: true }
const CHOICES: Record<AppTranscriptionBackendChoice, true> = { local: true, openai: true }
const REASONS: Record<AppNoTranscriberReason, true> = {
  unconfigured: true,
  unchosen: true,
  local_not_installed: true,
  openai_key_missing: true,
}
const KEY_SOURCES: Record<AppOpenAiKeySource, true> = {
  stored: true,
  shared: true,
  environment: true,
}
const PHASES: Record<AppWhisperInstallPhase, true> = {
  idle: true,
  checking_disk: true,
  downloading_binary: true,
  extracting_binary: true,
  downloading_model: true,
  verifying: true,
  done: true,
  failed: true,
}

// ── Fully-populated samples, one per side ───────────────────────────────
// Each literal is annotated with its OWN side's type, so each is checked
// against its own declaration (missing field → error, unknown field → excess-
// property error). The two are then asserted deep-equal, which reds if a field
// appears on one side only even in the runtime-only case.

const APP_SAMPLE: AppVoiceTranscriptionStatus = {
  backend: 'local',
  backend_reason: null,
  choice: 'local',
  local_available: true,
  openai_key: { present: true, source: 'stored', saved_at: '2026-01-01T00:00:00.000Z' },
  installed: true,
  model_id: 'base.en',
  installed_bytes: 148_000_000,
  binary_downloadable: true,
  binary_present: true,
  whisper_version: 'v1.7.4',
  default_model_id: 'base.en',
  models: [
    {
      id: 'base.en',
      label: 'Base (English)',
      size_bytes: 148_000_000,
      sec_per_30s_note: 3.2,
      peak_rss_mb: 310,
      note: 'A good default.',
    },
  ],
  job: {
    phase: 'downloading_model',
    received_bytes: 1_024,
    total_bytes: 148_000_000,
    model_id: 'base.en',
    error: { code: 'disk_full', message: 'not enough room' },
    started_at: 1_767_225_600_000,
  },
}

const WEB_SAMPLE: WebVoiceTranscriptionStatus = {
  backend: 'local',
  backend_reason: null,
  choice: 'local',
  local_available: true,
  openai_key: { present: true, source: 'stored', saved_at: '2026-01-01T00:00:00.000Z' },
  installed: true,
  model_id: 'base.en',
  installed_bytes: 148_000_000,
  binary_downloadable: true,
  binary_present: true,
  whisper_version: 'v1.7.4',
  default_model_id: 'base.en',
  models: [
    {
      id: 'base.en',
      label: 'Base (English)',
      size_bytes: 148_000_000,
      sec_per_30s_note: 3.2,
      peak_rss_mb: 310,
      note: 'A good default.',
    },
  ],
  job: {
    phase: 'downloading_model',
    received_bytes: 1_024,
    total_bytes: 148_000_000,
    model_id: 'base.en',
    error: { code: 'disk_full', message: 'not enough room' },
    started_at: 1_767_225_600_000,
  },
}

/** Every key at every level, so a nested field can't drift unnoticed. */
function deepKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    const base = prefix.replace(/\.$/, '')
    return value.flatMap((v, i) => deepKeys(v, `${base}[${i}].`))
  }
  if (value === null || typeof value !== 'object') return []
  return Object.keys(value as Record<string, unknown>)
    .flatMap((k) => [
      `${prefix}${k}`,
      ...deepKeys((value as Record<string, unknown>)[k], `${prefix}${k}.`),
    ])
    .sort()
}

function stubFetch(payload: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init !== undefined ? { init } : {}) })
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { impl, calls }
}

const BASE_URL = 'https://neutron.example.com'
const TOKEN = 'test-token'

describe('VoiceTranscriptionStatus — app ↔ web mirror', () => {
  test('the compile-time drift guards exist (they red in the typecheck job, not here)', () => {
    // `bun test` does not typecheck. These nine assertions are a signpost, not
    // the guard: the guard is `tsc -p app/tsconfig.json`, run by
    // `scripts/ci/typecheck-all.sh`. Deleting a guard silently disarms this
    // file, so the count is pinned.
    expect(DRIFT_GUARDS).toHaveLength(10)
    for (const g of DRIFT_GUARDS) expect(typeof g).toBe('function')
    expect(CONSTRUCTOR_SHAPE_GUARDS).toHaveLength(4)
    for (const g of CONSTRUCTOR_SHAPE_GUARDS) expect(typeof g).toBe('function')
  })

  test('bidirectional structural assignment compiles + round-trips at runtime', () => {
    const asWeb: WebVoiceTranscriptionStatus = APP_SAMPLE
    const backToApp: AppVoiceTranscriptionStatus = asWeb
    expect(backToApp).toEqual(APP_SAMPLE)

    const asApp: AppVoiceTranscriptionStatus = WEB_SAMPLE
    const backToWeb: WebVoiceTranscriptionStatus = asApp
    expect(backToWeb).toEqual(WEB_SAMPLE)
  })

  test('the two independently-typed samples carry exactly the same key tree', () => {
    expect(deepKeys(APP_SAMPLE)).toEqual(deepKeys(WEB_SAMPLE))
    // Guard the guard: `deepKeys` must actually reach the nested shapes.
    expect(deepKeys(APP_SAMPLE)).toContain('openai_key.source')
    expect(deepKeys(APP_SAMPLE)).toContain('job.error.code')
    expect(deepKeys(APP_SAMPLE)).toContain('models[0].sec_per_30s_note')
  })

  test('the samples are value-identical (a field on one side only reds here)', () => {
    expect(APP_SAMPLE).toEqual(WEB_SAMPLE as AppVoiceTranscriptionStatus)
  })
})

describe('component shapes — app ↔ web mirror', () => {
  test('WhisperModelOption round-trips both ways', () => {
    const app: AppWhisperModelOption = APP_SAMPLE.models[0]!
    const asWeb: WebWhisperModelOption = app
    const back: AppWhisperModelOption = asWeb
    expect(back).toEqual(app)
  })

  test('WhisperJob round-trips both ways, optional `error` included', () => {
    const app: AppWhisperJob = APP_SAMPLE.job!
    const asWeb: WebWhisperJob = app
    const back: AppWhisperJob = asWeb
    expect(back).toEqual(app)
    expect(back.error?.code).toBe('disk_full')
  })

  test('OpenAiKeyStatus round-trips both ways and never carries the key', () => {
    const app: AppOpenAiKeyStatus = APP_SAMPLE.openai_key
    const asWeb: WebOpenAiKeyStatus = app
    const back: AppOpenAiKeyStatus = asWeb
    expect(back).toEqual(app)
    // The status object reports presence + provenance, NEVER the secret.
    expect(deepKeys(app)).toEqual(['present', 'saved_at', 'source'])
  })
})

describe('literal unions agree across both declarations', () => {
  test('every member of every union is assignable both ways', () => {
    for (const v of Object.keys(BACKENDS) as AppTranscriptionBackend[]) {
      const asWeb: WebTranscriptionBackend = v
      const back: AppTranscriptionBackend = asWeb
      expect(back).toBe(v)
    }
    for (const v of Object.keys(CHOICES) as AppTranscriptionBackendChoice[]) {
      const asWeb: WebTranscriptionBackendChoice = v
      const back: AppTranscriptionBackendChoice = asWeb
      expect(back).toBe(v)
    }
    for (const v of Object.keys(REASONS) as AppNoTranscriberReason[]) {
      const asWeb: WebNoTranscriberReason = v
      const back: AppNoTranscriberReason = asWeb
      expect(back).toBe(v)
    }
    for (const v of Object.keys(KEY_SOURCES) as AppOpenAiKeySource[]) {
      const asWeb: WebOpenAiKeySource = v
      const back: AppOpenAiKeySource = asWeb
      expect(back).toBe(v)
    }
    for (const v of Object.keys(PHASES) as AppWhisperInstallPhase[]) {
      const asWeb: WebWhisperInstallPhase = v
      const back: AppWhisperInstallPhase = asWeb
      expect(back).toBe(v)
    }
  })

  test('the exhaustive enumerations pin the membership that exists today', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['local', 'none', 'openai'])
    expect(Object.keys(CHOICES).sort()).toEqual(['local', 'openai'])
    expect(Object.keys(REASONS).sort()).toEqual([
      'local_not_installed',
      'openai_key_missing',
      'unchosen',
      'unconfigured',
    ])
    expect(Object.keys(KEY_SOURCES).sort()).toEqual(['environment', 'shared', 'stored'])
    expect(Object.keys(PHASES).sort()).toEqual([
      'checking_disk',
      'done',
      'downloading_binary',
      'downloading_model',
      'extracting_binary',
      'failed',
      'idle',
      'verifying',
    ])
  })
})

describe('both clients normalize the same server payload identically', () => {
  // The type check above cannot see this: each file carries its OWN copy of
  // `normalizeStatus`, the old-server defaulting logic. A change to one copy is
  // invisible to `tsc` and reds only here.

  async function bothStatuses(payload: unknown) {
    const appStub = stubFetch(payload)
    const webStub = stubFetch(payload)
    const app = await new VoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: appStub.impl,
    }).status()
    const web = await new WebVoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: webStub.impl,
    }).status()
    return { app, web, appUrl: appStub.calls[0]!.url, webUrl: webStub.calls[0]!.url }
  }

  test('a current server response passes through both identically', async () => {
    const { app, web, appUrl, webUrl } = await bothStatuses(APP_SAMPLE)
    expect(app).toEqual(web)
    expect(app).toEqual(APP_SAMPLE)
    expect(appUrl).toBe(webUrl)
    expect(appUrl).toBe(`${BASE_URL}/api/app/voice-transcription`)
  })

  test('a server predating the backend-choice fields gets the same defaults on both', async () => {
    // No `backend_reason`, no `choice`, no `local_available`, no `openai_key` —
    // exactly what a server older than that feature sends.
    const legacy = {
      backend: 'local',
      installed: true,
      model_id: 'base.en',
      installed_bytes: 148_000_000,
      binary_downloadable: true,
      binary_present: true,
      whisper_version: 'v1.7.4',
      default_model_id: 'base.en',
      models: [],
      job: null,
    }
    const { app, web } = await bothStatuses(legacy)
    expect(app).toEqual(web)
    expect(app.backend_reason).toBeNull()
    expect(app.choice).toBeNull()
    expect(app.local_available).toBe(true) // falls back to `installed`
    expect(app.openai_key).toEqual({ present: false, source: null, saved_at: null })
  })

  test('an empty body yields the same defaulted shape on both', async () => {
    const { app, web } = await bothStatuses({})
    expect(app).toEqual(web)
    expect(app.local_available).toBe(false)
    expect(app.openai_key).toEqual({ present: false, source: null, saved_at: null })
  })

  test('every method hits the same URL on both clients', async () => {
    const cases: [(c: VoiceTranscriptionClient) => Promise<unknown>, (c: WebVoiceTranscriptionClient) => Promise<unknown>, string][] = [
      [(c) => c.status(), (c) => c.status(), '/api/app/voice-transcription'],
      [(c) => c.install('base.en'), (c) => c.install('base.en'), '/api/app/voice-transcription'],
      [(c) => c.remove(), (c) => c.remove(), '/api/app/voice-transcription'],
      [
        (c) => c.chooseBackend('openai'),
        (c) => c.chooseBackend('openai'),
        '/api/app/voice-transcription/backend',
      ],
      [
        (c) => c.saveOpenAiKey('sk-not-a-real-key'),
        (c) => c.saveOpenAiKey('sk-not-a-real-key'),
        '/api/app/voice-transcription/openai-key',
      ],
      [
        (c) => c.removeOpenAiKey(),
        (c) => c.removeOpenAiKey(),
        '/api/app/voice-transcription/openai-key',
      ],
    ]
    for (const [callApp, callWeb, suffix] of cases) {
      const appStub = stubFetch(APP_SAMPLE)
      const webStub = stubFetch(APP_SAMPLE)
      await callApp(
        new VoiceTranscriptionClient({
          base_url: BASE_URL,
          token: TOKEN,
          fetchImpl: appStub.impl,
        }),
      )
      await callWeb(
        new WebVoiceTranscriptionClient({
          base_url: BASE_URL,
          token: TOKEN,
          fetchImpl: webStub.impl,
        }),
      )
      expect(appStub.calls[0]!.url).toBe(`${BASE_URL}${suffix}`)
      expect(webStub.calls[0]!.url).toBe(`${BASE_URL}${suffix}`)
      expect(appStub.calls[0]!.init?.method).toBe(webStub.calls[0]!.init?.method as string)
    }
  })
})

// ── VoiceTranscriptionClientError — constructor shape (ISSUES #503) ──────

const REPO_ROOT = join(__dirname, '..', '..')
const APP_ROOT = join(__dirname, '..')

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8')
}

/**
 * The constructor's parameter list, IN ORDER, read out of the source text.
 *
 * This is the one guard that sees parameter NAMES. `tsc` does not compare them,
 * so a same-typed transposition — `(code, message)` against `(message, code)` —
 * is invisible to every type-level assertion in this file. Reading the text is
 * the tightest mechanism that can express it.
 *
 * Parameter-property modifiers are stripped: the app side declares its fields
 * as `readonly` constructor parameters and the web side assigns them in the
 * body, which is a style difference with no effect on a caller.
 */
function ctorParams(src: string, className: string): string[] {
  const cls = src.indexOf(`export class ${className} extends Error {`)
  expect(cls).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('constructor(', cls)
  expect(open).toBeGreaterThanOrEqual(0)
  const close = src.indexOf(')', open)
  expect(close).toBeGreaterThan(open)
  return src
    .slice(open + 'constructor('.length, close)
    .replace(/\b(readonly|public|private|protected)\b/g, '')
    .split(',')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p.length > 0)
}

/** What a `catch` block actually reads off one of these. */
function errShape(e: unknown): Record<string, unknown> {
  const err = e as { name: string; code: string; status: number; message: string }
  return { name: err.name, code: err.code, status: err.status, message: err.message }
}

describe('VoiceTranscriptionClientError — app ↔ web constructor shape', () => {
  const webSrc = read(REPO_ROOT, 'landing', 'chat-react', 'voice-transcription-client.ts')
  const appSrc = read(APP_ROOT, 'lib', 'voice-transcription-client.ts')

  test('both constructors take the same parameters, in the same order', () => {
    const app = ctorParams(appSrc, 'VoiceTranscriptionClientError')
    const web = ctorParams(webSrc, 'VoiceTranscriptionClientError')
    expect(app).toEqual(web)
    // Guard the guard. Pinned to the LITERAL signature, so an extractor that
    // silently returned `[]` — or dropped a parameter — cannot pass vacuously
    // by agreeing with itself on both sides. `(code, message, status)` is the
    // order all 23 of this repo's other client-error classes take.
    expect(app).toEqual(['code: string', 'message: string', 'status: number'])
  })

  test('the same three arguments land on the same three fields on both sides', () => {
    const app = new AppVoiceTranscriptionClientError('install_running', 'wait for it', 409)
    const web = new WebVoiceTranscriptionClientError('install_running', 'wait for it', 409)
    // Each field asserted against the argument it came from, so a transposed
    // constructor reds HERE with the wrong value rather than merely differing.
    for (const e of [app, web]) {
      expect(e.code).toBe('install_running')
      expect(e.status).toBe(409)
      expect(e.message).toBe('install_running: wait for it')
      expect(e.name).toBe('VoiceTranscriptionClientError')
    }
    expect(errShape(web)).toEqual(errShape(app))
  })

  test('a non-2xx from the same server body throws the same error on both', async () => {
    const body = { ok: false, code: 'install_running', message: 'wait for it to finish first' }
    const appErr = await new VoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: stubFetch(body, 409).impl,
    })
      .status()
      .catch((e: unknown) => e)
    const webErr = await new WebVoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: stubFetch(body, 409).impl,
    })
      .status()
      .catch((e: unknown) => e)

    expect(appErr).toBeInstanceOf(AppVoiceTranscriptionClientError)
    expect(webErr).toBeInstanceOf(WebVoiceTranscriptionClientError)
    // This is the end-to-end pin: it catches a transposition at the CALL SITES
    // inside either client, not just in the constructor declaration.
    expect(errShape(webErr)).toEqual(errShape(appErr))
    expect(errShape(appErr)).toEqual({
      name: 'VoiceTranscriptionClientError',
      code: 'install_running',
      status: 409,
      message: 'install_running: wait for it to finish first',
    })
  })

  test('a non-JSON body throws the same error on both, status preserved', async () => {
    const nonJson = (): Promise<Response> =>
      Promise.resolve(new Response('Not Found', { status: 404 }))
    const appErr = await new VoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: nonJson,
    })
      .status()
      .catch((e: unknown) => e)
    const webErr = await new WebVoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: nonJson,
    })
      .status()
      .catch((e: unknown) => e)

    expect(errShape(webErr)).toEqual(errShape(appErr))
    // The STATUS is the load-bearing field here: the screen turns 404 into
    // "your server is too old" rather than a raw parse error.
    expect(errShape(appErr)).toEqual({
      name: 'VoiceTranscriptionClientError',
      code: 'bad_response',
      status: 404,
      message: 'bad_response: HTTP 404',
    })
  })
})

describe('a server that never answers — both clients give up identically', () => {
  // The web client had NO timeout while the app had 15s (ISSUES #503). `fetch`
  // has no default one on either runtime, so a connection that is accepted and
  // then goes nowhere left the web card loading forever.

  /** Accepts the request and never answers — settles only on abort. */
  const hang = (_input: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
    })

  /**
   * Resolve to the client's outcome, or to the sentinel if it never settles.
   *
   * A client with no timeout does not REJECT — it hangs. Without this race the
   * removal of a timeout would show up as a suite-level stall rather than a
   * named failure, which is a bad way for a guard to red. The sentinel timer is
   * ~17x the injected 30 ms client timeout and is not an assertion about how
   * fast anything ran, so it is not a wall-clock bound (ISSUES #438).
   */
  const NEVER_SETTLED = 'NEVER_SETTLED'
  async function outcome(p: Promise<unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        p.then(() => 'RESOLVED').catch((e: unknown) => e),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(NEVER_SETTLED), 500)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  test('both time out with the same code, status and wording', async () => {
    const appErr = await outcome(
      new VoiceTranscriptionClient({
        base_url: BASE_URL,
        token: TOKEN,
        fetchImpl: hang,
        timeoutMs: 30,
      }).status(),
    )
    const webErr = await outcome(
      new WebVoiceTranscriptionClient({
        base_url: BASE_URL,
        token: TOKEN,
        fetchImpl: hang,
        timeoutMs: 30,
      }).status(),
    )

    expect(appErr).not.toBe(NEVER_SETTLED)
    expect(webErr).not.toBe(NEVER_SETTLED)
    expect(appErr).toBeInstanceOf(AppVoiceTranscriptionClientError)
    expect(webErr).toBeInstanceOf(WebVoiceTranscriptionClientError)
    // Equality across the two is what pins the wording; the literals below pin
    // the two fields a caller branches on. (The injected 30 ms rounds to "0s"
    // in the text, which is why the message is asserted by shape, not literal.)
    expect(errShape(webErr)).toEqual(errShape(appErr))
    expect((appErr as AppVoiceTranscriptionClientError).code).toBe('timeout')
    expect((appErr as AppVoiceTranscriptionClientError).status).toBe(0)
    expect((appErr as AppVoiceTranscriptionClientError).message).toContain(
      'the server did not answer within',
    )
  })

  test('the default timeout is the same constant on both sides', () => {
    // The behavioural test above injects `timeoutMs`, so it would still pass if
    // one side defaulted to 15s and the other to an hour. Pin the default.
    const constant = (src: string): string | undefined =>
      /const REQUEST_TIMEOUT_MS = ([\w_]+)/.exec(src)?.[1]
    const appSrc = read(APP_ROOT, 'lib', 'voice-transcription-client.ts')
    const webSrc = read(REPO_ROOT, 'landing', 'chat-react', 'voice-transcription-client.ts')
    expect(constant(appSrc)).toBe('15_000')
    expect(constant(webSrc)).toBe(constant(appSrc))
  })

  test('a successful request is untouched by the timeout on both clients', async () => {
    // The regression arm: an abort timer that fires on a request that already
    // finished, or a `finally` that failed to clear it, would show up here.
    const appStub = stubFetch(APP_SAMPLE)
    const webStub = stubFetch(APP_SAMPLE)
    const app = await new VoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: appStub.impl,
      timeoutMs: 30,
    }).status()
    const web = await new WebVoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: webStub.impl,
      timeoutMs: 30,
    }).status()
    expect(app).toEqual(web)
    expect(app).toEqual(APP_SAMPLE)
  })

  test('both clients pass an abort signal to fetch', async () => {
    // A timeout that never reaches `fetch` is a timer that fires into nothing.
    const appStub = stubFetch(APP_SAMPLE)
    const webStub = stubFetch(APP_SAMPLE)
    await new VoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: appStub.impl,
    }).status()
    await new WebVoiceTranscriptionClient({
      base_url: BASE_URL,
      token: TOKEN,
      fetchImpl: webStub.impl,
    }).status()
    expect(appStub.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
    expect(webStub.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })
})
