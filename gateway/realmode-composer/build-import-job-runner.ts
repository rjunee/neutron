/**
 * @neutronai/gateway/realmode-composer — history-import job-runner hook
 * builder (T4, 2026-05-13; rewritten v0.1.78, 2026-05-22).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 + § 4.7. Constructs a real
 * `ImportJobRunner` from the heavy-fixture closures (default source
 * parser, Pass-1 / Pass-2 substrate callers) and returns the hook the
 * engine treats as opaque.
 *
 * v0.1.78 (2026-05-22, "import resilience") removed:
 *   - the `BudgetCap` injection (budget-cap subsystem killed entirely)
 *   - the `BudgetWarningEmitter` callback (no more 80% prompt)
 *   - the `engine` / `url_slug` / `urlSlugResolver` / `topic_id` fields
 *     (only used for the budget-warning bridge)
 *
 * What stays:
 *   - LLM caller wiring (substrate-default or explicit overrides)
 *   - Pass-2 Sonnet 4.6 fallback on Opus 4.7 429 (independent feature)
 *   - filesystem / URL paste / chained payload resolvers
 *   - sync-on-disk + parse / chunker plumbing
 */

import { join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { lookup as dnsLookupDefault } from 'node:dns/promises'

/**
 * Argus r3 (fix-pass) — DNS-resolve lookup contract. Surfaces `node:dns`'s
 * `lookup(host, { all: true })` shape so `UrlPasteImportPayloadResolver`
 * can fail-closed against any private/internal IP the hostname resolves
 * to. Injectable so tests don't need to spin a real DNS server.
 */
export type DnsLookupAll = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>

import type { ProjectDb } from '../../persistence/index.ts'
import {
  ImportJobRunner,
  buildPass1SubstrateCaller,
  buildPass2SubstrateCaller,
  type CredentialKindResolver,
  type EntityPopulatorWriteEntityFn,
  type ImportPopulatorSyncHook,
  type Pass2SonnetFallbackHook,
  type SourceParser,
} from '../../onboarding/history-import/index.ts'
import { SONNET_MODEL } from '../../runtime/models.ts'
import { ImportError } from '../../onboarding/history-import/types.ts'
import { buildDefaultSourceParser } from '../../onboarding/history-import/default-source-parser.ts'
import type {
  Pass1LlmCall,
} from '../../onboarding/history-import/pass1-triage.ts'
import type {
  Pass2LlmCall,
} from '../../onboarding/history-import/pass2-synthesis.ts'
import type { Substrate } from '../../runtime/substrate.ts'
import type { GmailClient } from '../../onboarding/history-import/oauth-gmail.ts'
import type { CalendarClient } from '../../onboarding/history-import/oauth-calendar.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
  ImportResumeReadinessProbe,
} from '../../onboarding/interview/engine.ts'
import type { ImportSource, Pass1ChunkResult } from '../../onboarding/history-import/types.ts'
import { writeEntity as defaultWriteEntity } from '../../runtime/entity-writer.ts'
import {
  RESUMABLE_STATUSES,
  zipPathForSource,
} from '../upload/import-resume-handler.ts'

export interface BuildImportJobRunnerHookInput {
  db: ProjectDb
  /**
   * Pass-1 LLM caller. Production wires this to the Anthropic Haiku 4.5
   * substrate; tests inject deterministic mocks. When omitted, the
   * runner uses a no-op caller that returns empty results at $0 cost
   * (safe default; the engine surfaces "no signal extracted" downstream).
   */
  pass1Llm?: Pass1LlmCall
  /** Pass-2 LLM caller. Same pattern as `pass1Llm`. */
  pass2Llm?: Pass2LlmCall
  /**
   * T7 (2026-05-14) — Substrate used to default-build the Pass-1 + Pass-2
   * LLM callers per docs/plans/P2-onboarding.md § 2.3 + § 4.7. When
   * supplied AND neither `pass1Llm` nor `pass2Llm` is set, this hook:
   *   - constructs a Haiku-4.5 caller via `buildPass1SubstrateCaller`
   *   - constructs an Opus-4.7 caller via `buildPass2SubstrateCaller`
   *
   * Resolution priority — explicit caller overrides win (back-compat
   * with T4 tests that pass deterministic mocks), then substrate-default,
   * then the T4 `llm_unwired` placeholder so a misconfigured boot still
   * surfaces a user-visible failure (CLAUDE.md "Spec is the source of
   * truth").
   */
  substrate?: Substrate
  /** Override the Pass-1 prompt body. Defaults to the on-disk template. */
  pass1Prompt?: string
  /** Override the Pass-2 prompt body. Defaults to the on-disk template. */
  pass2Prompt?: string
  /** OAuth source parser deps; production threads the per-instance Google
   *  clients. Optional: when omitted, the OAuth sources throw at start
   *  time (the engine's failure branch surfaces retry/skip). */
  gmailClient?: GmailClient
  calendarClient?: CalendarClient
  /**
   * Override the SourceParser entirely. Tests use this to inject a
   * deterministic parser that yields canned conversations.
   */
  parse?: SourceParser
  /** Test-only override for the clock. */
  now?: () => number
  /** Test-only override for the uuid generator. */
  uuid?: () => string
  /**
   * Codex r6 P1 (post-T4) test seam — when true, bypasses the strict
   * "pass1Llm + pass2Llm required" guard. Only used by the
   * default-builder presence test (test 2) that never actually runs
   * an import end-to-end; every other call site MUST wire real LLM
   * callers.
   */
  __allowNoOpLlmForBoot?: boolean
  /**
   * P2-v2 S21 (2026-05-17) — telemetry hook fired exactly once per
   * Pass-2 synthesis that fell back from `BEST_MODEL` (Opus 4.7) to
   * `SONNET_MODEL` (Sonnet 4.6) because the primary call 429'd. The
   * hook lands BEFORE the Sonnet dispatch so the event timestamp
   * marks "noticed the 429 + reaching for Sonnet" rather than
   * "Sonnet finished". Production composer wires this against
   * `OnboardingTelemetry.emit('onboarding.pass2_sonnet_fallback_used',
   * ...)`; tests inject a recorder for deterministic assertions.
   */
  onSonnetFallback?: Pass2SonnetFallbackHook
  /**
   * v0.1.85 (2026-05-23) — credential-kind resolver threaded to the
   * runner so per-job Pass-1 chunk size adapts to the resolved
   * Anthropic credential. Max OAuth (`'oauth'`) → 4096-token chunks;
   * everything else → the 50K default. Production composer wires this
   * to the same `resolveLlmCredentials(...)` callback the lazy
   * `resolvePool` substrate uses, returning the primary credential's
   * `.kind`. Tests can inject a static resolver (returning `'oauth'`
   * or `'api_key'`) to exercise the chunk-size override deterministically.
   */
  getCurrentCredentialKind?: CredentialKindResolver
  /**
   * 2026-05-31 — Pass-1 worker-pool fan-out (number of concurrent
   * Pass-1 chunk LLM calls). Default 1 (2026-06-17; was 3) — one warm
   * `claude` session, sequential chunks. Override via
   * `NEUTRON_IMPORT_PASS1_CONCURRENCY` in the per-instance systemd unit's
   * `Environment=` block (or process env for dev runs). The composer
   * reads the env var, parses to integer, clamps to >=1, and threads
   * the value through to the runner. Tests pin to 1 for deterministic
   * sequential ordering.
   */
  pass1Concurrency?: number
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Bug D) — entity-
   * populator wiring. When `ownerDataDir` is supplied, the hook
   * threads it (plus a `writeEntity` callable + the optional GBrain
   * sync hook) through to the underlying `ImportJobRunner` so the
   * completed / partial Pass-2 result fan-out actually fires under
   * `populateEntitiesFromImport(...)`. Argus r1 BLOCKER #1 — the prior
   * shape of this builder constructed the runner WITHOUT these deps so
   * the populator's `runEntityPopulator` short-circuited on every
   * production import. Without that fan-out the entity tree (and KG)
   * stayed empty even after a successful import.
   *
   * Resolution order inside the builder:
   *   1. If `ownerDataDir` is unset → leave the runner deps blank.
   *      The populator no-ops at runtime; the runner's terminal-state
   *      transition continues unchanged. This is the safe default for
   *      tests + open-tier composers that don't have an `entities/`
   *      tree wired.
   *   2. If `ownerDataDir` is set AND `writeEntity` is unset → default
   *      to `writeEntity` from `runtime/entity-writer.ts`. Production
   *      composer takes this path; tests opt in by passing a recorder.
   *   3. `gbrainSyncHook` is forwarded as-is. When unset the entity
   *      writer still emits the on-disk markdown; KG population
   *      happens on the next sync sweep / external repair pass.
   */
  ownerDataDir?: string
  writeEntity?: EntityPopulatorWriteEntityFn
  gbrainSyncHook?: ImportPopulatorSyncHook
}

/**
 * Build a real `ImportJobRunner` + return an `ImportJobRunnerHook` the
 * engine treats as opaque. The hook proxies `start` / `status` /
 * `cancel` 1:1 to the underlying runner.
 */
export function buildImportJobRunnerHook(
  input: BuildImportJobRunnerHookInput,
): ImportJobRunnerHook {
  const parse: SourceParser =
    input.parse ??
    buildDefaultSourceParser({
      gmailClient: input.gmailClient ?? throwingGmailClient,
      calendarClient: input.calendarClient ?? throwingCalendarClient,
    })
  // T7 (2026-05-14) — substrate-backed default Pass-1 + Pass-2 callers
  // when the caller threads a Substrate through. Explicit `pass1Llm` /
  // `pass2Llm` overrides still win (back-compat with T4 tests that pass
  // deterministic mocks). If neither is wired AND no substrate is
  // supplied, fall through to the T4 `llm_unwired` placeholder so a
  // misconfigured boot still surfaces a user-visible failure (CLAUDE.md
  // "Spec is the source of truth"). Per docs/plans/P2-onboarding.md
  // § 2.3 + § 4.7 — Haiku-4.5 for Pass-1, Opus-4.7 for Pass-2.
  const pass1Default: Pass1LlmCall | null =
    input.substrate !== undefined
      ? buildPass1SubstrateCaller({ substrate: input.substrate })
      : null
  // P2-v2 S21 — ALWAYS-ON Sonnet 4.6 fallback for Pass-2 429
  // exhaustion. Sonnet fallback runs WITHIN one Pass-2 attempt; the
  // runner-level `retryWith429` loop then drives N attempts on top.
  // Sonnet success on a single attempt counts as Pass-2 success; the
  // outer rate-limit backoff only fires when BOTH Opus 4.7 AND
  // Sonnet 4.6 429 in the same attempt.
  const pass2Default: Pass2LlmCall | null =
    input.substrate !== undefined
      ? buildPass2SubstrateCaller({
          substrate: input.substrate,
          fallback_model_preference: [SONNET_MODEL],
          ...(input.onSonnetFallback !== undefined
            ? { onSonnetFallback: input.onSonnetFallback }
            : {}),
        })
      : null
  const llmCallersWired =
    (input.pass1Llm !== undefined || pass1Default !== null) &&
    (input.pass2Llm !== undefined || pass2Default !== null)
  if (!llmCallersWired && input.__allowNoOpLlmForBoot !== true) {
    // eslint-disable-next-line no-console
    console.warn(
      '[buildImportJobRunnerHook] pass1Llm / pass2Llm / substrate are NOT wired. ' +
        'Real imports will throw at runner.start time. Production composer ' +
        'must thread a `substrate` (or explicit `pass1Llm` + `pass2Llm`) into ' +
        'buildLandingStack so the runner can dispatch Haiku 4.5 / Opus 4.7.',
    )
  }
  const pass1: Pass1LlmCall =
    input.pass1Llm ??
    pass1Default ??
    (async () => {
      if (input.__allowNoOpLlmForBoot !== true) {
        throw new ImportError(
          'llm_unwired',
          null,
          'ImportJobRunner: pass1Llm is not wired — refusing to run an import. ' +
            'Production composer must thread `importSubstrate` (or `importPass1Llm`) into buildLandingStack.',
        )
      }
      return { result: null, dollars_billed: 0 }
    })
  const pass2: Pass2LlmCall =
    input.pass2Llm ??
    pass2Default ??
    (async () => {
      if (input.__allowNoOpLlmForBoot !== true) {
        throw new ImportError(
          'llm_unwired',
          null,
          'ImportJobRunner: pass2Llm is not wired — refusing to run Pass-2 synthesis. ' +
            'Production composer must thread `importSubstrate` (or `importPass2Llm`) into buildLandingStack.',
        )
      }
      return { result: null, dollars_billed: 0 }
    })
  const pass1Prompt =
    input.pass1Prompt ??
    loadPromptFromDisk('import-analyzer-pass1.md') ??
    DEFAULT_PASS1_PROMPT
  const pass2Prompt =
    input.pass2Prompt ??
    loadPromptFromDisk('import-analyzer-pass2.md') ??
    DEFAULT_PASS2_PROMPT
  const runnerDeps: ConstructorParameters<typeof ImportJobRunner>[0] = {
    db: input.db,
    pass1,
    pass2,
    pass1Prompt,
    pass2Prompt,
    parse,
  }
  if (input.now !== undefined) runnerDeps.now = input.now
  if (input.uuid !== undefined) runnerDeps.uuid = input.uuid
  if (input.getCurrentCredentialKind !== undefined) {
    runnerDeps.getCurrentCredentialKind = input.getCurrentCredentialKind
  }
  // 2026-05-31 — Pass-1 concurrency. Explicit override (tests, callers
  // that build their own composer slice) wins over the env-var default.
  // Env-var path tolerates missing / malformed values by falling back to
  // the runner's own default (3) — no startup throw on a typo'd env.
  const envConcurrencyRaw = process.env['NEUTRON_IMPORT_PASS1_CONCURRENCY']
  let resolvedConcurrency: number | undefined
  if (input.pass1Concurrency !== undefined) {
    resolvedConcurrency = input.pass1Concurrency
  } else if (envConcurrencyRaw !== undefined && envConcurrencyRaw.length > 0) {
    const parsed = Number.parseInt(envConcurrencyRaw, 10)
    if (Number.isFinite(parsed) && parsed >= 1) {
      resolvedConcurrency = parsed
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[buildImportJobRunnerHook] NEUTRON_IMPORT_PASS1_CONCURRENCY=${envConcurrencyRaw} could not be parsed as a positive integer; falling back to runner default (1)`,
      )
    }
  }
  if (resolvedConcurrency !== undefined) {
    runnerDeps.pass1Concurrency = resolvedConcurrency
  }
  // Bug D (Argus r1 BLOCKER #1) — entity-populator deps. The runner's
  // post-completion populator only fires when all three are set. The
  // production composer threads `ownerDataDir` from `owner_home`;
  // `writeEntity` defaults to `runtime/entity-writer.ts:writeEntity`
  // when only the dir is supplied; `gbrainSyncHook` is passed
  // through as-is (undefined when GBrain isn't wired for this
  // instance — the writer still emits markdown to disk, only the KG
  // fan-out is skipped). Tests can override `writeEntity` for
  // deterministic recorders.
  if (input.ownerDataDir !== undefined) {
    runnerDeps.ownerDataDir = input.ownerDataDir
    runnerDeps.writeEntity = input.writeEntity ?? defaultWriteEntity
    if (input.gbrainSyncHook !== undefined) {
      runnerDeps.gbrainSyncHook = input.gbrainSyncHook
    }
  } else if (input.writeEntity !== undefined) {
    // Tests may pass `writeEntity` without `ownerDataDir` to exercise
    // the populator wiring assertion — preserve the field so the
    // runner construction assertion still observes the value.
    runnerDeps.writeEntity = input.writeEntity
  }
  const runner = new ImportJobRunner(runnerDeps)
  return {
    async start(inp) {
      return runner.start(inp)
    },
    async status(job_id) {
      return runner.status(job_id)
    },
    async cancel(job_id) {
      return runner.cancel(job_id)
    },
    async synthesizeOnDemand(job_id, opts) {
      return runner.synthesizeOnDemand(job_id, opts)
    },
  }
}

const DEFAULT_PASS1_PROMPT =
  'Extract candidate entities, topics, and tasks from this conversation chunk. Return strict JSON: {candidate_entities, candidate_topics, candidate_tasks, voice_signals}.'

const DEFAULT_PASS2_PROMPT =
  'Aggregate the Pass-1 chunk outputs and propose 3-7 projects, 5-15 tasks, 3-5 reminders, and 5-20 entity pages. Return strict JSON: {entities, topics, proposed_projects, proposed_tasks, proposed_reminders, voice_signals, facts}.'

function loadPromptFromDisk(filename: string): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = join(here, '..', '..')
    const path = join(repoRoot, 'prompts', 'onboarding', filename)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function* throwingThreadIterable(): AsyncIterable<{
  thread_id: string
  snippet?: string
}> {
  throw new Error('gmail client not wired')
  // eslint-disable-next-line @typescript-eslint/no-unreachable
  yield { thread_id: 'unreachable' }
}

async function* throwingEventIterable(): AsyncIterable<{
  event_id: string
  start_ms: number
}> {
  throw new Error('calendar client not wired')
  // eslint-disable-next-line @typescript-eslint/no-unreachable
  yield { event_id: 'unreachable', start_ms: 0 }
}

const throwingGmailClient: GmailClient = {
  listThreads() {
    return throwingThreadIterable()
  },
  async getThread(): Promise<never> {
    throw new Error('gmail client not wired')
  },
}

const throwingCalendarClient: CalendarClient = {
  listEvents() {
    return throwingEventIterable()
  },
}

/**
 * T4 / Codex r2 P1 (post-T4) — filesystem-backed payload resolver.
 * Looks up the most-recent zip uploaded for `(instance, source)` under
 * `<owner_home>/imports/`. Used by `buildLandingStack` as the default
 * resolver so production has a working path the upload mechanism (HTTP
 * handler that writes to disk) can target without further engine
 * changes.
 */
export class FilesystemImportPayloadResolver implements ImportPayloadResolver {
  constructor(private readonly owner_home: string) {}

  async resolve(input: { project_slug: string; user_id: string; source: ImportSource }) {
    const filename = filenameFor(input.source)
    if (filename === null) return null
    const path = join(this.owner_home, 'imports', filename)
    if (!existsSync(path)) return null
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size === 0) return null
      return readFileSync(path)
    } catch {
      return null
    }
  }
}

function filenameFor(source: ImportSource): string | null {
  if (source === 'chatgpt-zip') return 'chatgpt.zip'
  if (source === 'claude-zip') return 'claude.zip'
  return null
}

/**
 * T4 / Codex r3 P1 (post-T4) — URL-fetching payload resolver. Per the
 * P2 spec § 2.3 v1 contract: "for v1, freeform paste of a presigned URL
 * is acceptable". The engine emits a follow-up paste prompt after the
 * user picks ChatGPT/Claude zip; on freeform paste of a URL, this
 * resolver fetches the bytes and hands the Buffer to the runner.
 */
export class UrlPasteImportPayloadResolver implements ImportPayloadResolver {
  private static readonly MAX_BYTES = 256 * 1024 * 1024 // 256 MB
  constructor(
    private readonly stateLookup: (input: {
      project_slug: string
      /** ISSUES #2 (2026-05-19) — second PK component. */
      user_id: string
      source: ImportSource
    }) => Promise<string | null>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly dnsLookup: DnsLookupAll = (host: string) =>
      dnsLookupDefault(host, { all: true }),
  ) {}

  async resolve(input: { project_slug: string; user_id: string; source: ImportSource }) {
    const url = await this.stateLookup(input)
    if (url === null || url.length === 0) return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    if (!(await this.resolveAndValidateHost(parsed.hostname))) return null
    let resp: Response
    try {
      resp = await this.walkRedirects(url)
    } catch {
      return null
    }
    if (!resp.ok) return null
    const lenHdr = resp.headers.get('content-length')
    if (lenHdr !== null) {
      const len = Number.parseInt(lenHdr, 10)
      if (Number.isFinite(len) && len > UrlPasteImportPayloadResolver.MAX_BYTES) return null
    }
    if (resp.body === null) {
      return null
    }
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) {
          total += value.byteLength
          if (total > UrlPasteImportPayloadResolver.MAX_BYTES) {
            try { await reader.cancel() } catch { /* ignore */ }
            return null
          }
          chunks.push(value)
        }
      }
    } catch {
      try { await reader.cancel() } catch { /* ignore */ }
      return null
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }

  private async walkRedirects(initialUrl: string): Promise<Response> {
    const MAX_HOPS = 5
    let currentUrl = initialUrl
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      let parsed: URL
      try {
        parsed = new URL(currentUrl)
      } catch {
        throw new Error('walkRedirects: malformed URL')
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('walkRedirects: non-http(s) protocol')
      }
      if (!(await this.resolveAndValidateHost(parsed.hostname))) {
        throw new Error(
          `walkRedirects: blocked redirect target (private/internal host or DNS resolves to one: ${parsed.hostname})`,
        )
      }
      const resp = await this.fetchImpl(currentUrl, { redirect: 'manual' })
      const isRedirect =
        resp.status === 301 ||
        resp.status === 302 ||
        resp.status === 303 ||
        resp.status === 307 ||
        resp.status === 308
      if (!isRedirect) return resp
      const location = resp.headers.get('location')
      if (location === null || location.length === 0) {
        throw new Error('walkRedirects: 3xx response missing Location header')
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        throw new Error('walkRedirects: malformed Location header')
      }
      currentUrl = nextUrl
    }
    throw new Error(`walkRedirects: too many redirects (>${MAX_HOPS})`)
  }

  private async resolveAndValidateHost(hostname: string): Promise<boolean> {
    if (isPrivateOrInternalHost(hostname)) return false
    if (isIpLiteral(hostname)) return true
    let addresses: ReadonlyArray<{ address: string; family: number }>
    try {
      addresses = await this.dnsLookup(hostname)
    } catch {
      return false
    }
    if (addresses.length === 0) return false
    for (const a of addresses) {
      if (isPrivateOrInternalHost(a.address)) return false
    }
    return true
  }
}

function isIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  const v6Raw = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  if (v6Raw.includes(':')) return true
  return false
}

function isPrivateOrInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.localhost')) return true
  if (h === '169.254.169.254' || h === 'metadata.google.internal' || h === 'metadata.azure.com') {
    return true
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4 !== null) {
    const o = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (o.some((n) => n > 255)) return true
    const [a, b] = o as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const v6Raw = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  if (v6Raw.includes(':')) {
    if (v6Raw === '::1') return true
    if (v6Raw.startsWith('fc') || v6Raw.startsWith('fd')) return true
    if (v6Raw.startsWith('fe80:')) return true
    if (v6Raw.startsWith('::ffff:')) {
      const inner = v6Raw.slice('::ffff:'.length)
      return isPrivateOrInternalHost(inner)
    }
    return false
  }
  return false
}

/**
 * Chain two resolvers: try the first; on null, fall through to the
 * second. Used by `buildLandingStack` to combine
 * `UrlPasteImportPayloadResolver` (user pastes a URL) with
 * `FilesystemImportPayloadResolver` (side-channel uploader drops a
 * zip on disk).
 */
export class ChainedImportPayloadResolver implements ImportPayloadResolver {
  constructor(private readonly chain: ReadonlyArray<ImportPayloadResolver>) {}

  async resolve(input: { project_slug: string; user_id: string; source: ImportSource }) {
    for (const r of this.chain) {
      const v = await r.resolve(input)
      if (v !== null) return v
    }
    return null
  }
}

/**
 * Convenience: a deterministic in-memory `ImportPayloadResolver` for
 * tests that want to seed a payload buffer without spinning up the
 * landing upload widget. Production wires a real resolver against the
 * landing-page upload pipeline.
 */
export class InMemoryImportPayloadResolver implements ImportPayloadResolver {
  private payloads: Map<string, Buffer | null> = new Map()

  set(input: { project_slug: string; source: ImportSource; payload: Buffer | null }): void {
    this.payloads.set(this.key(input.project_slug, input.source), input.payload)
  }

  async resolve(input: { project_slug: string; user_id: string; source: ImportSource }) {
    return this.payloads.get(this.key(input.project_slug, input.source)) ?? null
  }

  private key(project_slug: string, source: ImportSource): string {
    return `${project_slug}:${source}`
  }
}

/** Re-export for callers that need to inspect a Pass-1 chunk row. */
export type { Pass1ChunkResult }

/**
 * 2026-05-25 (import-pipeline-resilience sprint, Part G.2 + Argus r1
 * BLOCKER #3) — build the production `ImportResumeReadinessProbe` the
 * `InterviewEngine` consults when rendering `import_analysis_presented`
 * to decide whether to surface the `resume_import` button.
 *
 * Implementation walks the same gate as the HTTP resume handler so the
 * two surfaces agree byte-for-byte on what's resumable:
 *
 *   1. SELECT `status, source` from `import_jobs` WHERE (job_id,
 *      project_slug). When the row is absent OR status is NOT in
 *      `{cancelled, rate_limit_paused, failed}`, the probe returns
 *      false (no button).
 *   2. For `*-zip` sources, also verify the source ZIP exists at
 *      `<owner_home>/imports/<source>.zip`. OAuth sources skip the
 *      file check (the payload resolver re-fetches credentials).
 *   3. Any unexpected SQL throw returns false (fail-closed; the engine
 *      already logs the probe-thrown branch).
 *
 * Tests can pass `fs` for deterministic ZIP-existence assertions.
 *
 * Argus r1 BLOCKER #3 — without this builder the engine's
 * `importResumeReadiness` dep stayed unwired in production; the
 * `can_resume_import` flag was always false; the `resume_import`
 * button never rendered even when the source ZIP and the failed job
 * row were both present.
 */
export interface BuildImportResumeReadinessProbeInput {
  db: ProjectDb
  owner_home: string
  project_slug: string
  /** Test seam: `existsSync` shim. Defaults to `node:fs.existsSync`. */
  fs?: { existsSync: (p: string) => boolean }
}

export function buildImportResumeReadinessProbe(
  input: BuildImportResumeReadinessProbeInput,
): ImportResumeReadinessProbe {
  const fs = input.fs ?? { existsSync }
  return {
    async isResumable(probeInput): Promise<boolean> {
      let row: { status: string; source: string } | null = null
      try {
        row = input.db
          .raw()
          .query<{ status: string; source: string }, [string, string]>(
            `SELECT status, source FROM import_jobs
              WHERE job_id = ? AND project_slug = ?
              LIMIT 1`,
          )
          .get(probeInput.job_id, input.project_slug)
      } catch {
        return false
      }
      if (row === null) return false
      if (!RESUMABLE_STATUSES.includes(row.status)) return false
      const source = row.source as ImportSource
      if (source === 'chatgpt-zip' || source === 'claude-zip') {
        const zipPath = zipPathForSource(input.owner_home, source)
        if (!fs.existsSync(zipPath)) return false
      }
      return true
    },
  }
}
