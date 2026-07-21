/**
 * bundled-rituals.e2e.test.ts — the T7 LLM-behaviour acceptance for the two
 * ENGINE-shipped read-only rituals (plan task 7 / design §6 T7).
 *
 * The static half of the ported-prompt silent-no-op guard lives in
 * `bundled-rituals.test.ts` (template grounds on the Neutron layout, carries no
 * Vajra-isms). THIS test proves the BEHAVIOURAL half: each SHIPPED template, run
 * with the real ritual base prompt + the read-only ['Read','Glob','Grep'] surface
 * against a fixture instance, produces output that cites PLANTED fixture state —
 * something impossible to compose without actually reading the files. That is the
 * proof a ported prompt does not silently no-op (cost tokens, exit 0, do nothing).
 *
 * MIRRORS `runtime/adapters/claude-code/persistent/__tests__/dev-channel-pty-bind.e2e.test.ts`
 * mechanics EXACTLY (real Bun PTY spawn, dev-channel MCP sink for
 * /channel-ready //channel-bound //reply, disclaimer dismiss in onData,
 * MCP_CONNECTION_NONBLOCKING:'false'). Deltas from the sibling: cwd + addDir = a
 * mkdtemp FIXTURE owner_home; appendSystemPromptFile = RITUAL_AGENT_BASE_PROMPT;
 * tools = ['Read','Glob','Grep']; skipPermissions:true; the injected message is the
 * LIVE shipped template bytes (that is what T7 certifies).
 *
 * OPT-IN: needs a real `claude` binary + working credentials, so it is skipped
 * unless `NEUTRON_PTY_E2E=1`. CI (no creds) skips.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { buildReplArgv } from '@neutronai/runtime/adapters/claude-code/persistent/build-repl-argv.ts'
import { buildSettings } from '@neutronai/runtime/adapters/claude-code/persistent/build-settings.ts'
import { BunTerminalHost } from '@neutronai/runtime/adapters/claude-code/persistent/bun-terminal-host.ts'
import { ensureClaudeTrust } from '@neutronai/runtime/adapters/claude-code/persistent/ensure-claude-trust.ts'

import { RITUAL_AGENT_BASE_PROMPT } from './prompt-path.ts'
import { bundledTemplatePathFor } from './bundled-rituals.ts'

const OPT_IN = process.env['NEUTRON_PTY_E2E'] === '1'
const CLAUDE_BIN =
  process.env['CLAUDE_BIN'] ??
  [join(process.env['HOME'] ?? '', '.local/bin/claude'), '/usr/local/bin/claude'].find((p) =>
    existsSync(p),
  ) ??
  'claude'

const HERE = dirname(fileURLToPath(import.meta.url))
// reminders/ and runtime/ are monorepo siblings.
const DEV_CHANNEL = join(
  HERE,
  '..',
  'runtime',
  'adapters',
  'claude-code',
  'persistent',
  'dev-channel.ts',
)

/** Write the planted-fixture instance owner_home the rituals read from. */
function writeFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neutron-ritual-fixture-'))
  const aurora = join(home, 'Projects', 'aurora-relay')
  const harbor = join(home, 'Projects', 'quiet-harbor')
  mkdirSync(aurora, { recursive: true })
  mkdirSync(harbor, { recursive: true })
  writeFileSync(
    join(aurora, 'STATUS.md'),
    '# Aurora Relay — STATUS\n\n## Now\n- [ ] Fix the handshake retry storm in relay-core (RELAY-4471) — top priority\n- [ ] Draft failover runbook\n\n## Blocked\n- Waiting on upstream cert rotation (CERT-ROTATE-9) before staging deploy\n\n## Done recently\n- Landed the connection-pool rewrite\n',
    'utf8',
  )
  writeFileSync(
    join(harbor, 'STATUS.md'),
    '# Quiet Harbor — STATUS\n\n## Now\n- [ ] Write the harbor onboarding guide (HARBOR-812)\n\n## Notes\n- Beta waitlist at 40 signups; next review Friday\n',
    'utf8',
  )
  return home
}

/**
 * Spawn a real ritual REPL against `fixtureHome`, inject the LIVE shipped template
 * bytes for `id` as the user message, and return the ritual's final reply text.
 */
async function runRitual(id: string): Promise<string | undefined> {
  const fixtureHome = writeFixtureHome()
  const channelName = `neutron-${randomBytes(4).toString('hex')}`
  const sessionId = crypto.randomUUID()
  const cfgDir = mkdtempSync(join(tmpdir(), 'neutron-ritual-e2e-'))
  const mcpConfigPath = join(cfgDir, 'mcp.json')
  const settingsPath = join(cfgDir, 'settings.json')

  let channelPort = 0
  let bound = false
  let reply: string | undefined
  const sink = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url)
      let body: Record<string, unknown> = {}
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        /* ignore */
      }
      if (u.pathname === '/channel-ready') channelPort = Number(body['channel_port'] ?? 0)
      if (u.pathname === '/channel-bound') bound = true
      if (u.pathname === '/reply') reply = String(body['text'] ?? '')
      return Response.json({ ok: true })
    },
  })

  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [channelName]: {
          command: 'bun',
          args: [DEV_CHANNEL],
          env: {
            SINK_PORT: String(sink.port),
            SINK_TOKEN: 'e2e-token',
            SESSION_ID: sessionId,
            CHANNEL_NAME: channelName,
          },
        },
      },
    }),
  )
  buildSettings({ settingsPath })
  ensureClaudeTrust({ cwd: fixtureHome })

  const argv = buildReplArgv({
    claudeBin: CLAUDE_BIN,
    sessionId,
    resume: false,
    channelName,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile: RITUAL_AGENT_BASE_PROMPT,
    model: 'claude-opus-4-8',
    addDir: fixtureHome,
    tools: ['Read', 'Glob', 'Grep'],
    skipPermissions: true,
  })

  const host = new BunTerminalHost()
  const chunks: Buffer[] = []
  let dismissed = false
  let child: ReturnType<BunTerminalHost['spawn']> | null = null
  child = host.spawn(argv, {
    cwd: fixtureHome,
    env: { ...(process.env as Record<string, string>), MCP_CONNECTION_NONBLOCKING: 'false' },
    cols: 120,
    rows: 40,
    onData: (b) => {
      chunks.push(Buffer.from(b))
      if (dismissed) return
      const norm = Buffer.concat(chunks)
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\s+/g, '')
      if (/forlocalchanneldevelopment|usingthisforlocaldevelopment/i.test(norm)) {
        dismissed = true
        setTimeout(() => child?.writeKey?.('enter'), 400)
      }
    },
  })

  try {
    for (let i = 0; i < 60 && channelPort === 0; i++) await Bun.sleep(500)
    expect(channelPort).toBeGreaterThan(0)
    for (let i = 0; i < 40 && !bound; i++) await Bun.sleep(500)
    expect(bound).toBe(true)

    // Inject the LIVE shipped template bytes as the ritual's task — exactly what
    // the tick loop hands the substrate as `user_message`.
    const templateBytes = readFileSync(bundledTemplatePathFor(id), 'utf8')
    const r = await fetch(`http://127.0.0.1:${channelPort}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sink-Token': 'e2e-token' },
      body: JSON.stringify({ text: templateBytes, turn_id: '1:1' }),
    })
    expect(r.status).toBe(200)
    // Rituals are multi-step (glob + read several files + compose): poll longer.
    for (let i = 0; i < 120 && reply === undefined; i++) await Bun.sleep(500)
    return reply
  } finally {
    child?.kill('SIGTERM')
    sink.stop(true)
  }
}

describe.skipIf(!OPT_IN)('bundled rituals cite planted fixture state (T7 acceptance)', () => {
  it(
    'morning-brief output references a real fixture item',
    async () => {
      const reply = await runRitual('morning-brief')
      expect(reply).toBeDefined()
      // A marker that is not composable without actually reading the STATUS.md files.
      expect(reply).toMatch(/RELAY-4471|CERT-ROTATE-9|HARBOR-812/)
    },
    180_000,
  )

  it(
    'evening-wrap output references a real fixture item',
    async () => {
      const reply = await runRitual('evening-wrap')
      expect(reply).toBeDefined()
      expect(reply).toMatch(/RELAY-4471|CERT-ROTATE-9|HARBOR-812/)
    },
    180_000,
  )
})
