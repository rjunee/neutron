import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { SecretsStore } from '../secrets-store.ts'
import { ChatGPTOAuthClient, ChatGPTOAuthError } from '../chatgpt-oauth.ts'

let workdir: string
let db: ProjectDb
let dataDir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-cgpt-oauth-'))
  dataDir = join(workdir, 'project')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

interface FakeFetchCall {
  url: string
  init?: RequestInit | undefined
}

function buildClient(opts: {
  responses?: Array<{ status: number; body: unknown }>
  now?: () => number
  pollDeadlineMs?: number
}): { client: ChatGPTOAuthClient; calls: FakeFetchCall[]; secrets: SecretsStore } {
  const calls: FakeFetchCall[] = []
  const responses = [...(opts.responses ?? [])]
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected fetch call to ${url}`)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  const secrets = new SecretsStore({ data_dir: dataDir, db, ...(opts.now ? { now: opts.now } : {}) })
  const client = new ChatGPTOAuthClient({
    secrets,
    httpFetch: fakeFetch,
    sleep: async () => {},
    ...(opts.now ? { now: opts.now } : {}),
    config: {
      device_authorization_url: 'https://chatgpt.test/device',
      token_url: 'https://chatgpt.test/token',
      client_id: 'cgpt-test',
      poll_interval_ms: 10,
      ...(opts.pollDeadlineMs !== undefined ? { poll_deadline_ms: opts.pollDeadlineMs } : {}),
    },
  })
  return { client, calls, secrets }
}

test('startDeviceFlow returns user_code + verification_uri + expires_at', async () => {
  const now = 1_700_000_000_000
  const { client } = buildClient({
    now: () => now,
    responses: [
      {
        status: 200,
        body: {
          device_code: 'dev-1',
          user_code: 'CODE-1',
          verification_uri: 'https://chatgpt.test/activate',
          expires_in: 600,
          interval: 5,
        },
      },
    ],
  })
  const result = await client.startDeviceFlow({ internal_handle: asOwnerHandle('alice') })
  expect(result.device_code).toBe('dev-1')
  expect(result.user_code).toBe('CODE-1')
  expect(result.verification_uri).toBe('https://chatgpt.test/activate')
  expect(result.expires_at).toBe(now + 600_000)
  expect(result.poll_interval_ms).toBe(5_000)
})

test('pollUntilAuthorized stores the access + refresh tokens on success', async () => {
  const now = 1_700_000_000_000
  const { client, secrets } = buildClient({
    now: () => now,
    responses: [
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: {
          access_token: 'access-final',
          refresh_token: 'refresh-final',
          expires_in: 1_800,
          id_token: 'id-final',
        },
      },
    ],
  })
  const r = await client.pollUntilAuthorized({
    internal_handle: asOwnerHandle('alice'),
    device_code: 'dev-1',
    poll_interval_ms: 10,
  })
  expect(r.authorized).toBe(true)
  expect(r.expires_at).toBe(now + 1_800_000)
  const stored = await secrets.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'chatgpt_oauth',
    label: 'default',
  })
  expect(stored).not.toBeNull()
  if (stored !== null) {
    const parsed = JSON.parse(stored) as { access_token: string; refresh_token: string; id_token?: string }
    expect(parsed.access_token).toBe('access-final')
    expect(parsed.refresh_token).toBe('refresh-final')
    expect(parsed.id_token).toBe('id-final')
  }
})

test('pollUntilAuthorized surfaces access_denied as a typed error', async () => {
  const { client } = buildClient({
    responses: [{ status: 400, body: { error: 'access_denied' } }],
  })
  await expect(
    client.pollUntilAuthorized({
      internal_handle: asOwnerHandle('alice'),
      device_code: 'dev-1',
      poll_interval_ms: 10,
    }),
  ).rejects.toMatchObject({ code: 'access_denied' })
})

test('pollUntilAuthorized expires after the configured deadline', async () => {
  let now = 1_700_000_000_000
  const { client } = buildClient({
    now: () => now,
    pollDeadlineMs: 50,
    responses: [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
    ],
  })
  // Advance time past deadline after one fetch by hooking the sleep behavior.
  // Replace sleep callback by re-using the client's now closure: each loop
  // iteration starts by checking now < deadline; we mutate `now` between iterations.
  // The real client's sleep is mocked to no-op, so we simulate elapsed time
  // by mutating the closure variable.
  const original = client as unknown as { sleep: (ms: number) => Promise<void> }
  original.sleep = async () => {
    now += 100
  }
  await expect(
    client.pollUntilAuthorized({
      internal_handle: asOwnerHandle('alice'),
      device_code: 'dev-1',
      poll_interval_ms: 10,
    }),
  ).rejects.toMatchObject({ code: 'expired_token' })
})

test('writeCodexAuthFile writes a Codex-CLI shaped JSON to the target path', async () => {
  const now = 1_700_000_000_000
  const { client } = buildClient({
    now: () => now,
    responses: [
      {
        status: 200,
        body: {
          access_token: 'access-codex',
          refresh_token: 'refresh-codex',
          expires_in: 3_600,
          id_token: 'id-codex',
        },
      },
    ],
  })
  await client.pollUntilAuthorized({
    internal_handle: asOwnerHandle('alice'),
    device_code: 'dev',
    poll_interval_ms: 10,
  })
  const target = join(workdir, 'codex-auth.json')
  const result = await client.writeCodexAuthFile({
    internal_handle: asOwnerHandle('alice'),
    target_path: target,
  })
  expect(result.path).toBe(target)
  expect(existsSync(target)).toBe(true)
  const onDisk = JSON.parse(readFileSync(target, 'utf8')) as {
    tokens: { access_token: string; refresh_token: string; id_token?: string }
    last_refresh: string
  }
  expect(onDisk.tokens.access_token).toBe('access-codex')
  expect(onDisk.tokens.refresh_token).toBe('refresh-codex')
  expect(onDisk.tokens.id_token).toBe('id-codex')
})

test('writeCodexAuthFile throws not_found when no token is stored', async () => {
  const { client } = buildClient({})
  await expect(
    client.writeCodexAuthFile({
      internal_handle: asOwnerHandle('alice'),
      target_path: join(workdir, 'codex-auth.json'),
    }),
  ).rejects.toBeInstanceOf(ChatGPTOAuthError)
})

// Codex review fix — the bundle row must NOT be expires_at-gated, so the
// refresh token stays readable after the access token ages out.
test('stored ChatGPT bundle stays readable after the access-token expiry', async () => {
  let now = 1_700_000_000_000
  const { client, secrets } = buildClient({
    now: () => now,
    responses: [
      {
        status: 200,
        body: {
          access_token: 'access-short',
          refresh_token: 'refresh-long',
          expires_in: 60, // 1 min access token
          id_token: 'id-x',
        },
      },
    ],
  })
  await client.pollUntilAuthorized({
    internal_handle: asOwnerHandle('alice'),
    device_code: 'd',
    poll_interval_ms: 10,
  })
  // Advance time well past the access-token expiry.
  now += 10 * 60_000
  const stored = await secrets.get({
    internal_handle: asOwnerHandle('alice'),
    kind: 'chatgpt_oauth',
    label: 'default',
  })
  expect(stored).not.toBeNull()
  if (stored !== null) {
    const parsed = JSON.parse(stored) as {
      refresh_token: string
      access_token: string
      access_expires_at: number
    }
    expect(parsed.refresh_token).toBe('refresh-long')
    expect(parsed.access_token).toBe('access-short')
    // The stored bundle exposes when the access token expired so the
    // CLI can manage refresh on its own.
    expect(parsed.access_expires_at).toBe(1_700_000_000_000 + 60_000)
  }
  // writeCodexAuthFile still succeeds because the row isn't expired.
  const target = join(workdir, 'codex-auth.json')
  await client.writeCodexAuthFile({
    internal_handle: asOwnerHandle('alice'),
    target_path: target,
  })
})

// Codex r6 follow-up — `last_refresh` must reflect when the access
// token was actually obtained, not when the file was written. A delayed
// write (minutes/hours after pollUntilAuthorized) would otherwise stamp
// `last_refresh` with the file-write time and trick the Codex CLI into
// skipping a refresh on an already-stale token.
test('last_refresh stamps the token issue time, not the file-write time', async () => {
  const issueTime = 1_700_000_000_000
  let now = issueTime
  const { client } = buildClient({
    now: () => now,
    responses: [
      {
        status: 200,
        body: {
          access_token: 'access-fresh',
          refresh_token: 'refresh-fresh',
          expires_in: 3_600,
          id_token: 'id-fresh',
        },
      },
    ],
  })
  await client.pollUntilAuthorized({
    internal_handle: asOwnerHandle('alice'),
    device_code: 'dev',
    poll_interval_ms: 10,
  })
  // Advance the clock — simulate a delayed file write.
  now = issueTime + 60 * 60 * 1_000
  const target = join(workdir, 'codex-auth.json')
  await client.writeCodexAuthFile({
    internal_handle: asOwnerHandle('alice'),
    target_path: target,
  })
  const onDisk = JSON.parse(readFileSync(target, 'utf8')) as {
    last_refresh: string
  }
  // last_refresh must be the original token issue time, not now.
  expect(onDisk.last_refresh).toBe(new Date(issueTime).toISOString())
  expect(onDisk.last_refresh).not.toBe(new Date(now).toISOString())
})

// Argus r1, finding 3 — POSIX writeFileSync({mode:0o600}) only applies on
// CREATE; an existing file at 0o644 (e.g. user-created ~/.codex/auth.json)
// would stay world-readable after refresh. The fix is an explicit
// chmodSync after the write.
test('writeCodexAuthFile force-tightens mode to 0o600 on a pre-existing 0o644 file', async () => {
  const now = 1_700_000_000_000
  const { client } = buildClient({
    now: () => now,
    responses: [
      {
        status: 200,
        body: {
          access_token: 'access-tight',
          refresh_token: 'refresh-tight',
          expires_in: 3_600,
          id_token: 'id-tight',
        },
      },
    ],
  })
  await client.pollUntilAuthorized({
    internal_handle: asOwnerHandle('alice'),
    device_code: 'dev',
    poll_interval_ms: 10,
  })
  const target = join(workdir, 'pre-existing-auth.json')
  // Pre-create the file at 0o644 — simulates a user manually creating
  // ~/.codex/auth.json before the agent first writes to it. Verify
  // chmodSync (after write) tightens the mode regardless.
  writeFileSync(target, '{}', { mode: 0o644 })
  chmodSync(target, 0o644) // force the mode in case umask interfered
  // Sanity check the precondition.
  expect((statSync(target).mode & 0o777) & 0o077).not.toBe(0)

  await client.writeCodexAuthFile({
    internal_handle: asOwnerHandle('alice'),
    target_path: target,
  })

  // After the write, the mode must be 0o600 — group + other bits cleared.
  const finalMode = statSync(target).mode & 0o777
  expect(finalMode).toBe(0o600)
})
