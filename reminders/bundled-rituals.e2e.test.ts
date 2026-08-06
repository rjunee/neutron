/**
 * bundled-rituals.e2e.test.ts — the T7 LLM-behaviour acceptance for the
 * ENGINE-shipped bundled rituals (plan task 7 / design §6 T7).
 *
 * The static half of the ported-prompt silent-no-op guard lives in
 * `bundled-rituals.test.ts` (template grounds on the Neutron layout, carries no
 * the legacy harness-isms). THIS test proves the BEHAVIOURAL half: each SHIPPED template, run
 * with the real ritual base prompt + THAT DEF'S OWN tool surface against a
 * fixture instance, produces output that cites PLANTED fixture state —
 * something impossible to compose without actually reading the files. That is the
 * proof a ported prompt does not silently no-op (cost tokens, exit 0, do nothing).
 *
 * For `kaizen` the bar is higher, because a weekly report is the easiest thing in
 * this repo to fake: reading the files is necessary but NOT sufficient. Its
 * fixture plants ONE lesson corrected four times under four wordings, so the
 * assertion is that the ritual recognised the REPEAT and proposed a rule change —
 * a run that faithfully lists four corrections and proposes nothing has failed at
 * the only job kaizen has.
 *
 * MIRRORS `runtime/adapters/claude-code/persistent/__tests__/dev-channel-pty-bind.e2e.test.ts`
 * mechanics EXACTLY (real Bun PTY spawn, dev-channel MCP sink for
 * /channel-ready //channel-bound //reply, disclaimer dismiss in onData,
 * MCP_CONNECTION_NONBLOCKING:'false'). Deltas from the sibling: cwd + addDir = a
 * mkdtemp FIXTURE owner_home; skipPermissions:true; the injected message is the
 * LIVE shipped template bytes (that is what T7 certifies).
 *
 * ISSUES #504 UPDATE — the harness now spawns with `DEFAULT_AGENT_BASE_PROMPT`
 * (the ordinary chat persona) rather than a dedicated ritual persona, because that
 * is what production does: a ritual composes on the owner's normal warm session.
 * The deleted `ritual-agent-base.md` had no delivery mechanism left — a system
 * prompt is a SPAWN-time property and a warm session is already spawned. What this
 * test certifies is unchanged: each shipped template, given a tool surface and a
 * fixture instance, produces output that cites PLANTED state, which is impossible
 * without actually reading the files.
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

import { DEFAULT_AGENT_BASE_PROMPT } from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import { BUNDLED_RITUAL_DEFS, bundledTemplatePathFor } from './bundled-rituals.ts'

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

/** Write a planted-fixture self-improvement layer (corrections + persona rules +
 *  diary) that the kaizen ritual reads.
 *
 *  The plant is the RITUAL'S JOB, not just a marker: the SAME lesson
 *  (`LEDGER-7431`) is corrected FOUR times across the week under four different
 *  wordings, and `persona/SOUL.md` contains no rule about it. A kaizen that
 *  merely summarises reports four corrections; the kaizen we want notices they
 *  are ONE missing rule and says so. `PRISM-88` is a single-occurrence
 *  distractor — it must not be promoted to systemic. */
function writeKaizenFixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neutron-ritual-kaizen-fixture-'))
  mkdirSync(join(home, 'corrections'), { recursive: true })
  mkdirSync(join(home, 'diary'), { recursive: true })
  mkdirSync(join(home, 'persona'), { recursive: true })
  const now = Date.now()
  const at = (daysAgo: number): string => new Date(now - daysAgo * 86_400_000).toISOString()
  const block = (ts: string, id: string, wrong: string, right: string, why: string): string =>
    `## ${ts} · ${id}\n\n- **wrong:** ${wrong}\n- **right:** ${right}\n- **why:** ${why}\n- **scope:** general\n- **source:** owner\n\n`

  writeFileSync(
    join(home, 'corrections', 'corrections-log.md'),
    '---\nkind: corrections-log\n---\n\n# Corrections Log\n\n' +
      // One lesson, four times, four wordings.
      block(at(6), 'c-e2e1', 'used the old ledger flow', 'route billing through LEDGER-7431', 'the migration is live') +
      block(at(4), 'c-e2e2', 'posted an invoice against the legacy ledger', 'every billing write goes through LEDGER-7431', 'the old path is frozen') +
      block(at(2), 'c-e2e3', 'reconciled against the pre-migration ledger', 'reconcile through LEDGER-7431 only', 'twice now') +
      block(at(1), 'c-e2e4', 'quoted a balance from the legacy ledger again', 'read balances from LEDGER-7431', 'this keeps happening') +
      // A one-off that must NOT be called systemic.
      block(at(3), 'c-e2e5', 'left the PRISM-88 flag on after the refactor', 'clear the PRISM-88 flag when the refactor lands', 'one-off'),
    'utf8',
  )
  writeFileSync(
    join(home, 'persona', 'SOUL.md'),
    '# Standing rules\n\n- Be concise.\n- Never send external communications without approval.\n',
    'utf8',
  )
  writeFileSync(
    join(home, 'diary', `${at(1).slice(0, 10)}.md`),
    `# Diary\n\n- ${at(1)} | reflection | - | Shipped the PRISM-88 refactor and noted the follow-ups.\n`,
    'utf8',
  )
  return home
}

/**
 * Spawn a real ritual REPL against `fixtureHome`, inject the LIVE shipped template
 * bytes for `id` as the user message, and return the ritual's final reply text.
 */
async function runRitual(id: string, fixture: () => string = writeFixtureHome): Promise<string | undefined> {
  const fixtureHome = fixture()
  // The surface comes from the DEF, not a hardcoded triple: kaizen is granted
  // WebSearch on top of the read-only three, and an e2e that silently ran it
  // with the wrong tools would certify a ritual nobody ships.
  const def = BUNDLED_RITUAL_DEFS.find((d) => d.id === id)
  if (def === undefined) throw new Error(`runRitual: no bundled def '${id}'`)
  const tools = [...def.tool_surface]
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
    appendSystemPromptFile: DEFAULT_AGENT_BASE_PROMPT,
    model: 'claude-opus-4-8',
    addDir: fixtureHome,
    tools,
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

  it(
    'kaizen names the REPEATED correction as systemic, not just the week',
    async () => {
      const reply = await runRitual('kaizen', writeKaizenFixtureHome)
      expect(reply).toBeDefined()
      // Read the files at all: not composable without the corrections log.
      expect(reply).toMatch(/LEDGER-7431/)
      // Did its JOB: recognised four wordings as ONE recurring lesson. Either the
      // explicit label or the count is acceptable evidence; a bare summary of the
      // week's corrections satisfies neither.
      expect(reply).toMatch(/SYSTEMIC|systemic|4 times|four times|repeat/i)
      // Proposed a change to the rules file, which is where a missing rule lives.
      expect(reply).toMatch(/SOUL\.md/)
    },
    180_000,
  )
})
