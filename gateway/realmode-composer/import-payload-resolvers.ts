/**
 * @neutronai/gateway/realmode-composer — import payload resolvers + resume
 * readiness probe.
 *
 * (K3, 2026-07-03) — relocated verbatim from the deleted
 * `build-import-job-runner.ts`. Only `buildImportJobRunnerHook` (the dead
 * per-chunk runner builder) was removed; these payload resolvers + the
 * resume-readiness probe are used UNCONDITIONALLY on the LIVE path by
 * `build-landing-stack.ts` (reached via `open/composer.ts`), so they move
 * here rather than being deleted. Behaviour is byte-identical to the
 * pre-deletion definitions (SSRF guard, redirect walk, byte cap, resume
 * gate).
 */

import { join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { lookup as dnsLookupDefault } from 'node:dns/promises'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ImportSource, Pass1ChunkResult } from '@neutronai/onboarding/history-import/types.ts'
import type {
  ImportPayloadResolver,
  ImportResumeReadinessProbe,
} from '@neutronai/onboarding/interview/engine.ts'
import { RESUMABLE_STATUSES, zipPathForSource } from '../upload/import-resume-handler.ts'

/**
 * Argus r3 (fix-pass) — DNS-resolve lookup contract. Surfaces `node:dns`'s
 * `lookup(host, { all: true })` shape so `UrlPasteImportPayloadResolver`
 * can fail-closed against any private/internal IP the hostname resolves
 * to. Injectable so tests don't need to spin a real DNS server.
 */
export type DnsLookupAll = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>

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
      // Defensive boundary (K11c Codex r1): `row.source` is an unvalidated
      // DB string. Only the two zip sources are resumable; any legacy non-zip
      // `-oauth` string a historical row could carry (migration 0040's CHECK
      // still permits them) is NOT resumable, so the UI never advertises an
      // impossible resume button for it.
      if (source !== 'chatgpt-zip' && source !== 'claude-zip') return false
      const zipPath = zipPathForSource(input.owner_home, source)
      if (!fs.existsSync(zipPath)) return false
      return true
    },
  }
}
