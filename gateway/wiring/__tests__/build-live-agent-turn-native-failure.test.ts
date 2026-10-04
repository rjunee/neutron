import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import { createPersistentReplSubstrate, bakedChildSinkInfo, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { sink } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { TurnIdEcho } from '@neutronai/runtime/adapters/claude-code/persistent/turn-id-echo.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import { openAdmission } from './project-admission-fixture.ts'

const dirs: string[] = []
afterEach(async () => {
  await shutdownAllPersistentRepls()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('native terminal error reaches chat, releases conversation admission, and the warm next turn replies', async () => {
  let spawnCount = 0
  let turnCount = 0
  let killCount = 0
  const echo = new TurnIdEcho()
  const hookStatuses: unknown[] = []
  const host: PtyHost = {
    async spawn(argv) {
      spawnCount++
      const sessionId = argv[argv.indexOf('--session-id') + 1]!
      const source = argv[argv.indexOf('--dangerously-load-development-channels') + 1]!.slice('server:'.length)
      const { port, token } = bakedChildSinkInfo(argv)
      const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8'))
      const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token }, body: JSON.stringify(body),
      })
      const hook = async (event: string, body: Record<string, unknown>) => {
        const config = settings.hooks[event]?.[0]?.hooks?.[0]
        expect(config?.type).toBe('http')
        const response = await fetch(config.url, { method: 'POST', headers: config.headers,
          body: JSON.stringify({ session_id: sessionId, hook_event_name: event, ...body }) })
        hookStatuses.push(await response.json())
      }
      let exited = false
      let resolveExit!: (code: number | null) => void
      const exit = new Promise<number | null>(resolve => { resolveExit = resolve })
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/health') return Response.json({ ok: true })
        const body = await req.json() as { text: string; turn_id: string }
        if (path === '/turn-ended') {
          const retired = echo.onTerminalFailure(body.turn_id)
          return Response.json({ status: retired ? 'retired' : 'uncorrelated' }, { status: retired ? 200 : 409 })
        }
        if (path !== '/message') return new Response('missing', { status: 404 })
        echo.onInject(body.turn_id)
        turnCount++
        const promptId = randomUUID()
        await hook('UserPromptSubmit', { prompt_id: promptId,
          prompt: `<channel source="${source}" session_id="${sessionId}" user="neutron" turn_id="${body.turn_id}">\n${body.text}\n</channel>` })
        if (turnCount === 1) {
          await hook('StopFailure', { prompt_id: promptId, error: 'server_error',
            last_assistant_message: 'API Error: Connection dropped (ECONNRESET)' })
        } else {
          await post('/reply', { session_id: sessionId, turn_id: echo.onReply(), text: 'Second turn replied.' })
        }
        return Response.json({ status: 'delivered' })
      } })
      await post('/channel-ready', { session_id: sessionId, channel_port: server.port })
      await post('/channel-bound', { session_id: sessionId })
      return { pid: 4444, write() {}, resize() {}, exited: exit, hasExited: () => exited,
        kill() { killCount++; exited = true; server.stop(true); resolveExit(0) }, wasKilledByUs: () => exited }
    },
  }
  const admission = openAdmission()
  const childLease = await admission.admit('native-failure-project', 'liveChild', 'native-child', 'unresolved-native-work')
  if (childLease.status !== 'admitted') throw new Error('fixture native child admission refused')
  const heldChildren = admission.service.listLeases('liveChild')
  const ownerHome = mkdtempSync(join(tmpdir(), 'native-failure-chat-'))
  dirs.push(ownerHome)
  const substrate = createPersistentReplSubstrate({ substrate_instance_id: `native-failure-${randomUUID()}`,
    cwd: '/tmp', ptyHost: host, skipTrustSeed: true, idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 2000, readyIntervalMs: 5, healthBudgetMs: 2000, healthIntervalMs: 5 },
  })
  const observed: unknown[] = []
  const run = buildLiveAgentTurn({ admission, substrate, personaLoader: { async load() { return '' } },
    buttonStore: new ButtonStore({ db: admission.db }), project_slug: 'owner', owner_home: ownerHome,
    activityInspector: { on_event: (_scope, event) => { observed.push(event) }, turn_started() {}, turn_finished() {} },
    model: 'claude-opus-4-7', ack_delay_ms: 60_000 })
  const sent: unknown[] = []
  const args = { project_slug: 'owner', project_id: 'native-failure-project', user_id: 'test-user', topic_id: 'native-failure-topic',
    user_text: 'Check readiness.', observed_at: 0, send: (event: unknown) => { sent.push(event) } }
  const failed = await run(args)
  expect(failed.outcome).toBe('failed')
  expect(observed).toContainEqual({ kind: 'error', message: 'API Error: Connection dropped (ECONNRESET)', retryable: false })
  expect(JSON.stringify(sent)).toContain('I hit a problem answering that.')
  expect(admission.service.listLeases('conversation')).toHaveLength(0)
  expect(admission.service.listLeases('liveChild')).toEqual(heldChildren)
  const cleanupDeadline = Date.now() + 1000
  while (sink.registeredSessions().some(session => session.activeTurn !== undefined) && Date.now() < cleanupDeadline) await Bun.sleep(5)
  expect([...sink.registeredSessions()].every(session => session.activeTurn === undefined && session.turnSlotHeld === 0)).toBe(true)
  const completed = await run({ ...args, user_text: 'Try another turn.' })
  expect(completed.outcome).toBe('replied')
  expect(JSON.stringify(sent)).toContain('Second turn replied.')
  expect(hookStatuses).toEqual([{ status: 'bound' }, { status: 'failed' }, { status: 'bound' }])
  expect(echo.staleReplyDebt).toBe(0)
  expect(spawnCount).toBe(1)
  expect(killCount).toBe(0)
  expect(admission.service.listLeases('conversation')).toHaveLength(0)
  expect(admission.service.listLeases('liveChild')).toEqual(heldChildren)
  await childLease.release()
}, 15_000)
