/**
 * @neutronai/onboarding/interview — fixture-backed `AnthropicMessagesClient`.
 *
 * Spec: docs/plans/2026-05-22-e2e-onboarding-walkthrough.md § Part A.3.
 *
 * Loads JSON fixture files from a directory (`NEUTRON_E2E_LLM_FIXTURES_DIR`)
 * and serves them in place of real Anthropic API calls when the E2E
 * harness boots the gateway. The router and any other downstream
 * consumer of the `AnthropicMessagesClient` interface see a
 * deterministic, replay-stable response on every call.
 *
 * Fixture file layout
 * -------------------
 *
 *   <fixturesDir>/
 *     <call-id>.json       # one fixture per logical LLM call
 *
 * Each fixture is a JSON object with this shape:
 *
 *   {
 *     "call_id": "router-signup-name",
 *     "match": {
 *       "model_in": ["claude-haiku-...", "claude-sonnet-..."],
 *       "system_contains": ["onboarding router"],
 *       "user_contains": ["inbound_user_text"]
 *     },
 *     "response": {
 *       "content": [{ "type": "text", "text": "{\"action\":\"advance\", ...}" }]
 *     }
 *   }
 *
 * Match resolution (first-match-wins):
 *   - `model_in` — if present, the incoming `model` must appear in the list.
 *   - `system_contains` — each entry must appear in `args.system` (case-sensitive).
 *   - `user_contains` — each entry must appear in the concatenated user
 *     message bodies (case-sensitive).
 *
 * Ordering — fixtures are walked in lexicographic order of their on-disk
 * filename so the resolution is deterministic across runs / OSs (Bun's
 * `readdirSync` returns OS-order otherwise). Use prefixes like `00-`,
 * `01-` to control precedence when two fixtures could match the same call.
 *
 * On miss the client throws a `FixtureMissError` listing the call's
 * (model, system-prefix, user-prefix) so the harness operator can author
 * the missing fixture quickly.
 *
 * No watching, no caching invalidation — fixtures are loaded ONCE at
 * construction and held in memory. Re-launch the harness to pick up
 * fixture edits. This matches the discipline in `phase-spec-resolver`'s
 * static fallback layer: deterministic data = deterministic tests.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.ts'

export interface FixtureMatch {
  /** When set, the inbound `args.model` must appear in this list. */
  model_in?: ReadonlyArray<string>
  /** Every entry must appear in the inbound `args.system`. */
  system_contains?: ReadonlyArray<string>
  /** Every entry must appear in the concatenated user-role message bodies. */
  user_contains?: ReadonlyArray<string>
}

export interface FixtureResponseBlock {
  type?: 'text'
  text: string
}

export interface Fixture {
  call_id: string
  match: FixtureMatch
  response: { content: ReadonlyArray<FixtureResponseBlock> }
}

export interface FixtureAnthropicClientOptions {
  fixturesDir: string
  /** Test seam — defaults to a no-op. */
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void
  /** Optional list of pre-loaded fixtures. When supplied, the constructor
   *  skips disk reads. Useful for unit tests + a way to compose fixtures
   *  in-memory in the smoke test. */
  fixtures?: ReadonlyArray<Fixture>
}

export class FixtureMissError extends Error {
  override readonly name = 'FixtureMissError'
  constructor(
    message: string,
    readonly probe: {
      model: string
      system_prefix: string
      user_prefix: string
      candidates: ReadonlyArray<string>
    },
  ) {
    super(message)
  }
}

export class FixtureLoadError extends Error {
  override readonly name = 'FixtureLoadError'
}

interface NormalisedFixture {
  call_id: string
  source_path: string | null
  model_in: ReadonlySet<string> | null
  system_contains: ReadonlyArray<string>
  user_contains: ReadonlyArray<string>
  response: AnthropicMessageResponse
}

export class FixtureAnthropicClient implements AnthropicMessagesClient {
  private readonly fixtures: ReadonlyArray<NormalisedFixture>
  private readonly log: NonNullable<FixtureAnthropicClientOptions['log']>
  private readonly fixturesDir: string

  constructor(opts: FixtureAnthropicClientOptions) {
    this.fixturesDir = opts.fixturesDir
    this.log = opts.log ?? defaultLog
    const loaded: NormalisedFixture[] = []
    if (opts.fixtures !== undefined) {
      for (const raw of opts.fixtures) {
        loaded.push(normalise(raw, null))
      }
    } else {
      loaded.push(...loadFixturesFromDisk(opts.fixturesDir))
    }
    this.fixtures = loaded
    this.log('info', 'fixture-anthropic-client loaded', {
      fixtures_count: this.fixtures.length,
      fixtures_dir: this.fixturesDir,
    })
  }

  messages = {
    create: async (input: {
      model: string
      system?: string
      messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
      max_tokens: number
      signal?: AbortSignal
    }): Promise<AnthropicMessageResponse> => {
      const probe = buildProbe(input)
      for (const fixture of this.fixtures) {
        if (matches(fixture, input, probe)) {
          this.log('info', 'fixture matched', {
            call_id: fixture.call_id,
            model: input.model,
          })
          return fixture.response
        }
      }
      const candidates = this.fixtures.map((f) => f.call_id)
      throw new FixtureMissError(
        `no fixture matched LLM call (model=${input.model}, system_prefix="${probe.system_prefix}", user_prefix="${probe.user_prefix}"). ` +
          `Candidates: ${candidates.join(', ')}. ` +
          `Author a fixture at ${this.fixturesDir}/<call-id>.json.`,
        {
          model: input.model,
          system_prefix: probe.system_prefix,
          user_prefix: probe.user_prefix,
          candidates,
        },
      )
    },
  }

  /** Test seam — exposes the loaded fixture call_ids for assertions. */
  listCallIds(): ReadonlyArray<string> {
    return this.fixtures.map((f) => f.call_id)
  }
}

/**
 * Convenience factory: reads `NEUTRON_E2E_LLM_FIXTURES_DIR` and returns
 * either a `FixtureAnthropicClient` (when set) or `null` (when unset).
 * The composer threads this through `buildGatewayLlmRouter`: when the
 * env is unset, the composer keeps the production `anthropicClient`.
 */
export function maybeBuildFixtureClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log?: FixtureAnthropicClientOptions['log'],
): FixtureAnthropicClient | null {
  const dir = env['NEUTRON_E2E_LLM_FIXTURES_DIR']
  if (typeof dir !== 'string' || dir.length === 0) return null
  const opts: FixtureAnthropicClientOptions = { fixturesDir: dir }
  if (log !== undefined) opts.log = log
  return new FixtureAnthropicClient(opts)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function loadFixturesFromDisk(dir: string): NormalisedFixture[] {
  let stat
  try {
    stat = statSync(dir)
  } catch (err) {
    throw new FixtureLoadError(
      `fixtures dir ${dir} does not exist: ${(err as Error).message}`,
    )
  }
  if (!stat.isDirectory()) {
    throw new FixtureLoadError(`fixtures dir ${dir} is not a directory`)
  }
  const entries = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
  const out: NormalisedFixture[] = []
  for (const name of entries) {
    const path = join(dir, name)
    let parsed: Fixture
    try {
      const raw = readFileSync(path, 'utf8')
      parsed = JSON.parse(raw) as Fixture
    } catch (err) {
      throw new FixtureLoadError(
        `fixture ${path} failed to parse: ${(err as Error).message}`,
      )
    }
    if (typeof parsed.call_id !== 'string' || parsed.call_id.length === 0) {
      throw new FixtureLoadError(`fixture ${path} missing call_id`)
    }
    if (parsed.response === null || typeof parsed.response !== 'object') {
      throw new FixtureLoadError(`fixture ${path} missing response`)
    }
    out.push(normalise(parsed, path))
  }
  return out
}

function normalise(raw: Fixture, source_path: string | null): NormalisedFixture {
  if (raw.response === null || raw.response === undefined) {
    throw new FixtureLoadError(`fixture ${raw.call_id} missing response`)
  }
  if (!Array.isArray(raw.response.content)) {
    throw new FixtureLoadError(`fixture ${raw.call_id} response.content must be an array`)
  }
  const textBlocks: ReadonlyArray<{ text: string }> = raw.response.content
    .filter(
      (b): b is FixtureResponseBlock => typeof b?.text === 'string',
    )
    .map((b) => ({ text: b.text }))
  if (textBlocks.length === 0) {
    throw new FixtureLoadError(
      `fixture ${raw.call_id} must contain at least one text block in response.content`,
    )
  }
  const m = raw.match ?? {}
  return {
    call_id: raw.call_id,
    source_path,
    model_in:
      Array.isArray(m.model_in) && m.model_in.length > 0
        ? new Set(m.model_in)
        : null,
    system_contains: Array.isArray(m.system_contains) ? m.system_contains : [],
    user_contains: Array.isArray(m.user_contains) ? m.user_contains : [],
    response: { content: textBlocks },
  }
}

function buildProbe(args: {
  system?: string
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
}): { system_prefix: string; user_prefix: string; concatenatedUser: string } {
  const system_prefix = truncate(args.system ?? '', 160)
  const concatenatedUser = args.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
  const user_prefix = truncate(concatenatedUser, 160)
  return { system_prefix, user_prefix, concatenatedUser }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

function matches(
  f: NormalisedFixture,
  args: { model: string; system?: string },
  probe: { concatenatedUser: string },
): boolean {
  if (f.model_in !== null && !f.model_in.has(args.model)) return false
  const sys = args.system ?? ''
  for (const needle of f.system_contains) {
    if (!sys.includes(needle)) return false
  }
  for (const needle of f.user_contains) {
    if (!probe.concatenatedUser.includes(needle)) return false
  }
  return true
}

function defaultLog(
  level: 'info' | 'warn',
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (level === 'info') return
  const tail = meta !== undefined ? ` ${JSON.stringify(meta)}` : ''
  console.warn(`[fixture-anthropic-client] ${msg}${tail}`)
}
