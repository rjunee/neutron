/**
 * I/O-contract test for the TodoWrite→Work Board PostToolUse hook. Runs the hook
 * as a real subprocess (exactly as CC invokes it) with a stubbed reply-sink
 * HTTP server, asserting it forwards `tool_input.todos` to `/todo-sync` with the
 * shared token + baked SESSION_ID — and stays a silent no-op on the fail-soft
 * paths (missing env, non-TodoWrite tool, absent todos).
 *
 * The hook AWAITS its fetch before `process.exit(0)`, so once the child exits,
 * the POST has already been received + answered by the stub — no sleep or
 * polling needed (which also avoids a late POST leaking across tests). We spawn
 * ASYNC (`Bun.spawn` + `await proc.exited`), NOT `spawnSync`: the stub server
 * lives in this same process, so a synchronous spawn would freeze the event loop
 * and deadlock the child's POST.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'hooks', 'todo-sync.ts')
// bun cold-start under a loaded CI box can be slow; give each subprocess room.
const TEST_TIMEOUT_MS = 45_000

interface Captured {
  token: string | null
  body: { session_id?: string; todos?: unknown }
}

let server: ReturnType<typeof Bun.serve> | undefined
let captured: Captured[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== '/todo-sync') return new Response('nope', { status: 404 })
      const body = (await req.json()) as Captured['body']
      captured.push({ token: req.headers.get('X-Sink-Token'), body })
      return Response.json({ status: 'ok' })
    },
  })
})

afterAll(() => {
  server?.stop(true)
})

afterEach(() => {
  captured = []
})

async function runHook(
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn(['bun', HOOK], {
    env,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return await proc.exited
}

async function runHookRaw(stdin: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(['bun', HOOK], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return await proc.exited
}

/** process.env WITH the sink coords present. */
function wiredEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    SINK_PORT: String(server!.port),
    SINK_TOKEN: 'sink-secret-123',
    SESSION_ID: 'sess-abc',
  }
}

/** process.env WITHOUT any sink coords (the not-wired case). */
function unwiredEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) }
  delete env['SINK_PORT']
  delete env['SINK_TOKEN']
  delete env['SESSION_ID']
  return env
}

const TODOS = [
  { content: 'scaffold the module', status: 'in_progress', activeForm: 'scaffolding' },
  { content: 'write the tests', status: 'pending', activeForm: 'writing tests' },
]

describe('todo-sync hook', () => {
  it(
    'forwards TodoWrite todos to /todo-sync with token + baked session id',
    async () => {
      const status = await runHook(
        { session_id: 'cc-session', tool_name: 'TodoWrite', tool_input: { todos: TODOS } },
        wiredEnv(),
      )
      expect(status).toBe(0)
      expect(captured.length).toBe(1)
      expect(captured[0]!.token).toBe('sink-secret-123')
      // SESSION_ID comes from ENV, not the stdin session_id.
      expect(captured[0]!.body.session_id).toBe('sess-abc')
      expect(captured[0]!.body.todos).toEqual(TODOS)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'no-ops (no POST) when the sink env is not wired',
    async () => {
      const status = await runHook(
        { tool_name: 'TodoWrite', tool_input: { todos: TODOS } },
        unwiredEnv(),
      )
      expect(status).toBe(0)
      expect(captured.length).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'no-ops for a non-TodoWrite tool_name',
    async () => {
      const status = await runHook({ tool_name: 'Bash', tool_input: { todos: TODOS } }, wiredEnv())
      expect(status).toBe(0)
      expect(captured.length).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'no-ops when tool_input.todos is absent',
    async () => {
      const status = await runHook({ tool_name: 'TodoWrite', tool_input: {} }, wiredEnv())
      expect(status).toBe(0)
      expect(captured.length).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'exits 0 on malformed stdin (fail-soft)',
    async () => {
      const status = await runHookRaw('not json', wiredEnv())
      expect(status).toBe(0)
      expect(captured.length).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )
})
