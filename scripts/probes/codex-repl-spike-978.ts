/**
 * codex-repl-spike-978.ts — LIVE PROBE, not a build. Issue #978, pivot plan
 * `docs/plans/harness-orchestrator-pivot-2026-09-11.md:137-140`:
 *
 *   (a) accept follow-up turns reliably,
 *   (b) survive a gateway restart and resume,
 *   (c) complete an approval round-trip,
 *
 * measured against the REAL `codex` binary through the code that exists:
 * `runtime/adapters/codex-cli/persistent/project-session.ts` (the TUI under a
 * PtyHost) — never against a fake. The in-process `BunTerminalHost` is used, with a
 * tap on its `createTerminal` seam so a headless VT renders the same bytes the host
 * accumulates; the session rollout JSONL under `$CODEX_HOME/sessions` is the ground
 * truth for "the turn was answered", independent of screen parsing.
 *
 * Usage (from the repo root, CODEX_HOME pointing at a live ChatGPT-subscription slot):
 *
 *   bun scripts/probes/codex-repl-spike-978.ts refuse   <project-cwd> <out-dir>
 *   bun scripts/probes/codex-repl-spike-978.ts turns    <project-cwd> <out-dir>
 *   bun scripts/probes/codex-repl-spike-978.ts orphan   <project-cwd> <out-dir>
 *   bun scripts/probes/codex-repl-spike-978.ts approval <project-cwd> <out-dir> <outside-file>
 *
 * Optional: PROBE_XTERM=/path/to/node_modules/@xterm/headless renders real screens;
 * without it the screen column of the transcript is the ANSI-stripped byte stream.
 * Nothing here is production code and nothing here is imported by production code.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BunTerminalHost } from '../../runtime/adapters/claude-code/persistent/bun-terminal-host.ts'
import { hostSupportsAdoption, type AdoptableHost, type PtyChild } from '../../runtime/adapters/claude-code/persistent/pty-host.ts'
import { CodexProjectSession, CodexProjectSessionHost } from '../../runtime/adapters/codex-cli/persistent/project-session.ts'

const [mode, projectCwd, outDir, extra] = process.argv.slice(2)
if (!mode || !projectCwd || !outDir) {
  console.error('usage: <refuse|turns|orphan|approval> <project-cwd> <out-dir> [outside-file]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const codexHome = process.env['CODEX_HOME']
if (!codexHome) throw new Error('CODEX_HOME must point at the probe slot')
if (process.env['OPENAI_API_KEY']) throw new Error('refusing to run with OPENAI_API_KEY set: subscription only')

// ── transcript ────────────────────────────────────────────────────────────────
const t0 = Date.now()
const transcriptPath = join(outDir, `transcript-${mode}.log`)
const redactions: Array<[string, string]> = []
for (const [env, tag] of [['PROBE_REDACT_ROOT', '$OWNER_ROOT'], ['HOME', '$HOME']] as const) {
  const v = process.env[env]
  if (v) redactions.push([v, tag])
}
redactions.push([outDir, '$OUT'], [projectCwd, '$PROJECT'], [codexHome, '$CODEX_HOME'])
const redact = (s: string): string => {
  let out = s
  for (const [from, to] of redactions) out = out.split(from).join(to)
  return out
}
function log(line: string): void {
  const stamped = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`
  console.log(stamped)
  appendFileSync(transcriptPath, redact(stamped) + '\n')
}
function logBlock(title: string, body: string): void {
  log(`── ${title} ──`)
  for (const l of body.split('\n')) appendFileSync(transcriptPath, redact('    ' + l) + '\n')
  console.log(body.split('\n').map((l) => '    ' + l).join('\n'))
}

// ── screen instrument ─────────────────────────────────────────────────────────
const COLS = 120
const ROWS = 40
type Renderer = { write(b: Uint8Array): void; screen(): string }
async function makeRenderer(): Promise<Renderer> {
  const path = process.env['PROBE_XTERM']
  if (path) {
    const mod = (await import(path)) as { Terminal: new (o: object) => any }
    const term = new mod.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 })
    return {
      write: (b) => term.write(b),
      screen: () => {
        const buf = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
        while (lines.length && lines[lines.length - 1] === '') lines.pop()
        return lines.join('\n')
      },
    }
  }
  let acc = ''
  return {
    write: (b) => {
      acc += Buffer.from(b).toString('utf8')
    },
    screen: () =>
      acc
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .slice(-4000),
  }
}

// ── rollout instrument (ground truth) ─────────────────────────────────────────
interface RolloutEvent { type: string; payload: any; timestamp: string }
function listRollouts(): string[] {
  const root = join(codexHome!, 'sessions')
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}
function readEvents(path: string): RolloutEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as RolloutEvent
      } catch {
        return null
      }
    })
    .filter((e): e is RolloutEvent => e !== null)
}
async function findRolloutFor(cwd: string, since: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const p of listRollouts()) {
      if (statSync(p).mtimeMs < since - 1000) continue
      const first = readEvents(p)[0]
      if (first?.type === 'session_meta' && first.payload?.cwd === cwd && Date.parse(first.payload.timestamp) >= since - 5000) return p
    }
    await Bun.sleep(500)
  }
  throw new Error(`no rollout for cwd ${cwd} appeared within ${timeoutMs}ms`)
}
const taskCompletes = (events: RolloutEvent[]) => events.filter((e) => e.type === 'event_msg' && e.payload?.type === 'task_complete')
// item_completed.item.text is EMPTY for AgentMessage in a TUI rollout (measured);
// the text lives in response_item assistant output_text and task_complete.last_agent_message.
const agentMessages = (events: RolloutEvent[]) =>
  events.filter((e) => e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'assistant')
    .map((e) => (e.payload.content ?? []).map((c: any) => c.text ?? '').join(''))
const userMessages = (events: RolloutEvent[]) =>
  events.filter((e) => e.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user')
    .map((e) => (e.payload.content ?? []).map((c: any) => c.text ?? '').join(''))
    .filter((t: string) => !t.startsWith('<'))

/** The TUI thread for this cwd created after `since`, via codex's own state db. */
function newThreadsFor(cwd: string, since: number): Array<{ id: string; rollout_path: string }> {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(join(codexHome!, 'state_5.sqlite'), { readonly: true })
  try {
    return db.query('select id, rollout_path from threads where cwd = ? and created_at_ms >= ? order by created_at_ms').all(cwd, since - 1000) as Array<{ id: string; rollout_path: string }>
  } finally {
    db.close()
  }
}

/** PROBE-SIDE SUBMIT, NOT THE PRODUCTION PATH: text, a pause, then Enter. Exists
 *  only because production submitLine (text+\r back-to-back) is not taken as a
 *  submit by the codex TUI (measured: gap 0 ms -> 3/3 not submitted; 50/150/500 ms
 *  -> submitted). Used to measure whether follow-ups work once a line lands. */
async function gappedSubmit(child: PtyChild, text: string, gapMs = 150): Promise<void> {
  child.write(text)
  await Bun.sleep(gapMs)
  child.writeKey?.('enter')
}

async function waitForTaskComplete(rollout: string, alreadyDone: number, timeoutMs: number, renderer: Renderer): Promise<RolloutEvent[]> {
  const deadline = Date.now() + timeoutMs
  let lastScreenLog = 0
  while (Date.now() < deadline) {
    const events = readEvents(rollout)
    if (taskCompletes(events).length > alreadyDone) return events
    if (Date.now() - lastScreenLog > 15000) {
      lastScreenLog = Date.now()
      logBlock('screen while waiting', renderer.screen().split('\n').slice(-12).join('\n'))
    }
    await Bun.sleep(400)
  }
  throw new Error(`no task_complete beyond #${alreadyDone} within ${timeoutMs}ms`)
}

// ── spawn through the real host, exactly the harness argv ─────────────────────
const HARNESS_ARGV = ['codex', '--enable', 'multi_agent_v2'] // project-session.ts:142

async function spawnUnderBunHost(argv: string[], renderer: Renderer): Promise<PtyChild> {
  const host = new BunTerminalHost({
    createTerminal: (opts) =>
      new Bun.Terminal({
        ...opts,
        data: (term: any, bytes: Uint8Array) => {
          renderer.write(bytes)
          opts.data?.(term, bytes)
        },
      }) as any,
  })
  const child = await host.spawn(argv, {
    cwd: projectCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    label: 'neutron-codex-spike978',
    onScreen: () => {},
    cols: COLS,
    rows: ROWS,
  })
  child.beginOutput?.()
  log(`spawned ${JSON.stringify(argv)} pid=${child.pid} paneHandle=${JSON.stringify(child.paneHandle)}`)
  return child
}

async function waitScreen(renderer: Renderer, needle: RegExp, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (needle.test(renderer.screen())) return true
    await Bun.sleep(250)
  }
  log(`TIMEOUT waiting for ${what} (${timeoutMs}ms)`)
  return false
}

/** Drive the TUI to a ready composer: answer the trust prompt if it appears. Returns
 *  whether a trust prompt was seen — project-session.ts has no handler for it. */
async function reachComposer(child: PtyChild, renderer: Renderer): Promise<{ trustPrompt: boolean; ready: boolean }> {
  // The splash paints "Ask Codex to do anything" BEFORE the header, and then with
  // "model: loading" in the header (measured, runs 1 and 2: a predicate on the
  // composer text alone passed at +0.3s on a half-painted frame and the submitted
  // line was lost). Ready = header resolved ("model:" without "loading"), composer
  // present, no dialog, and the frame unchanged for 2 s.
  const isTrust = (s: string) => /Do you trust the contents of this directory/.test(s)
  const isReady = (s: string) => /model:\s+(?!loading)\S/.test(s) && /Ask Codex to do anything/.test(s) && !isTrust(s)
  let trustPrompt = false
  const deadline = Date.now() + 45000
  let stableSince = 0
  let last = ''
  while (Date.now() < deadline) {
    const s = renderer.screen()
    if (isTrust(s)) {
      trustPrompt = true
      logBlock('screen: TRUST PROMPT (project-session.ts:148 discards screens; nothing answers this)', s)
      child.writeKey?.('enter')
      log('probe pressed Enter on the trust prompt ("1. Yes, continue")')
      await Bun.sleep(500)
      continue
    }
    if (s !== last) {
      last = s
      stableSince = Date.now()
    } else if (isReady(s) && Date.now() - stableSince >= 2000) {
      logBlock('screen: composer (stable 2 s)', s)
      return { trustPrompt, ready: true }
    }
    await Bun.sleep(250)
  }
  logBlock('screen: composer NOT ready by deadline', renderer.screen())
  return { trustPrompt, ready: false }
}

// ── modes ─────────────────────────────────────────────────────────────────────
async function modeRefuse(): Promise<void> {
  log('MODE refuse — CodexProjectSessionHost.open() with the in-process host, real binary')
  const bunHost = new BunTerminalHost()
  log(`hostSupportsAdoption(BunTerminalHost) = ${hostSupportsAdoption(bunHost)}  (pty-host.ts:474-482)`)
  const registryPath = join(outDir, 'registry.json')
  const sessions = new CodexProjectSessionHost({ registryPath, host: bunHost as unknown as AdoptableHost, bin: 'codex' })
  const before = new Set((await Bun.$`pgrep -f "codex --enable multi_agent_v2"`.nothrow().text()).split('\n').filter(Boolean))
  try {
    const s = await sessions.open({ projectId: 'spike978', cwd: projectCwd, env: { ...process.env } })
    log(`UNEXPECTED: open() resolved recovery=${s.recovery} paneHandle=${s.paneHandle}`)
  } catch (error) {
    log(`open() rejected: ${(error as Error).message}`)
  }
  await Bun.sleep(1500)
  const after = new Set((await Bun.$`pgrep -f "codex --enable multi_agent_v2"`.nothrow().text()).split('\n').filter(Boolean))
  const leaked = [...after].filter((p) => !before.has(p))
  log(`codex processes new since open(): ${JSON.stringify(leaked)} (empty = the refused child was killed, project-session.ts:177)`)
  log(`registry file written: ${existsSync(registryPath)}`)
}

async function modeTurns(): Promise<void> {
  log('MODE turns — (a) follow-up turns on ONE real codex TUI under BunTerminalHost')
  const renderer = await makeRenderer()
  const since = Date.now()
  const child = await spawnUnderBunHost(HARNESS_ARGV, renderer)
  const session = new CodexProjectSession('spike978', `bun-pid:${child.pid}`, 'started', child)
  try {
    const { trustPrompt, ready } = await reachComposer(child, renderer)
    log(`trust prompt seen: ${trustPrompt}; composer ready: ${ready}`)
    if (!ready) throw new Error('composer never became ready')

    // ── step 1: the PRODUCTION submit path, unmodified ──
    const t1 = 'Remember this token: QUOKKA-7731. Reply with exactly the single word STORED and nothing else.'
    log(`[production] session.submitLine #1: ${JSON.stringify(t1)}`)
    await session.submitLine(t1)
    log('[production] submitLine #1 RESOLVED (project-session.ts:102 -> bun-terminal-host.ts:510-511 accepted text and \\r)')
    let threads: Array<{ id: string; rollout_path: string }> = []
    for (const d = Date.now() + 20000; Date.now() < d && threads.length === 0; await Bun.sleep(500)) threads = newThreadsFor(projectCwd, since)
    const composer = renderer.screen().split('\n').filter((l) => l.startsWith('›')).at(-1)
    log(`[production] 20 s after the acknowledged submit: turn started = ${threads.length > 0}; composer line = ${JSON.stringify(composer)}`)
    if (threads.length === 0) {
      logBlock('[production] screen: the line is still in the composer, unsubmitted', renderer.screen().split('\n').slice(-8).join('\n'))
      child.writeKey?.('enter')
      log('[probe] sent ONE extra Enter to submit what production left in the composer')
      for (const d = Date.now() + 20000; Date.now() < d && threads.length === 0; await Bun.sleep(500)) threads = newThreadsFor(projectCwd, since)
      log(`[probe] turn started after the extra Enter = ${threads.length > 0}`)
      if (threads.length === 0) throw new Error('turn 1 never started even after an extra Enter')
    }
    const rollout = threads[0]!.rollout_path
    log(`thread ${threads[0]!.id}; rollout ${rollout}`)
    const meta = readEvents(rollout)[0]?.payload
    log(`session_meta: originator=${meta?.originator} source=${meta?.source} cli=${meta?.cli_version}`)
    const started1 = Date.now()
    let events = await waitForTaskComplete(rollout, 0, 240000, renderer)
    let done = taskCompletes(events).length
    log(`turn #1 task_complete (${Date.now() - started1}ms after start observed); answer: ${JSON.stringify(taskCompletes(events).at(-1)?.payload?.last_agent_message)}`)
    const tc = events.find((e) => e.type === 'turn_context')?.payload
    log(`turn_context: approval_policy=${JSON.stringify(tc?.approval_policy)} sandbox=${JSON.stringify(tc?.sandbox_policy)} model=${tc?.model}`)

    // ── steps 2-4: three FOLLOW-UP turns, probe-side gapped submit, wait for idle ──
    const followups = [
      'What token did I ask you to remember? Reply with exactly that token and nothing else.',
      'Reply with exactly the token from earlier followed by a space and the word AGAIN.',
      'How many messages have I sent you in this conversation so far, including this one? Reply with exactly one digit.',
    ]
    for (const [i, text] of followups.entries()) {
      await Bun.sleep(1500)
      const started = Date.now()
      log(`[probe gapped submit] follow-up #${i + 1}: ${JSON.stringify(text)}`)
      await gappedSubmit(child, text)
      events = await waitForTaskComplete(rollout, done, 240000, renderer)
      done = taskCompletes(events).length
      log(`follow-up #${i + 1} task_complete in ${Date.now() - started}ms; answer: ${JSON.stringify(taskCompletes(events).at(-1)?.payload?.last_agent_message)}`)
    }
    log(`same thread throughout: ${newThreadsFor(projectCwd, since).length === 1} (threads for this cwd since spawn: ${newThreadsFor(projectCwd, since).length})`)
    log(`user messages in rollout: ${JSON.stringify(userMessages(events))}`)
    log(`assistant messages in rollout: ${JSON.stringify(agentMessages(events))}`)
    const tokens = events.filter((e) => e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info).map((e) => e.payload.info.last_token_usage)
    log(`per-turn last_token_usage (input/cached): ${JSON.stringify(tokens.map((t: any) => t && [t.input_tokens, t.cached_input_tokens]))}`)
    logBlock('screen after follow-ups', renderer.screen().split('\n').slice(-18).join('\n'))

    // ── step 5: a submit that lands WHILE a turn is running ──
    log('[probe] mid-turn submit: start a ~20 s turn, then submit another line 3 s into it')
    await Bun.sleep(1500)
    await gappedSubmit(child, 'Run the shell command `sleep 15` and then reply with exactly: LONG-DONE')
    await Bun.sleep(3000)
    await gappedSubmit(child, 'Reply with exactly: MIDTURN-ARRIVED')
    logBlock('screen 1 s after the mid-turn submit', (await Bun.sleep(1000), renderer.screen()).split('\n').slice(-14).join('\n'))
    events = await waitForTaskComplete(rollout, done, 240000, renderer)
    done = taskCompletes(events).length
    log(`after mid-turn submit: task_complete #${done}: ${JSON.stringify(taskCompletes(events).at(-1)?.payload?.last_agent_message)}`)
    try {
      events = await waitForTaskComplete(rollout, done, 90000, renderer)
      done = taskCompletes(events).length
      log(`next task_complete #${done}: ${JSON.stringify(taskCompletes(events).at(-1)?.payload?.last_agent_message)}`)
    } catch (e) {
      log(`no further task_complete within 90 s: ${(e as Error).message}`)
    }
    log(`user messages now: ${JSON.stringify(userMessages(readEvents(rollout)).slice(-3))}`)
    log(`assistant messages now: ${JSON.stringify(agentMessages(readEvents(rollout)).slice(-3))}`)
    writeFileSync(join(outDir, 'rollout-turns.jsonl'), redact(readFileSync(rollout, 'utf8')))
    writeFileSync(join(outDir, 'turns-thread-id.txt'), threads[0]!.id + '\n')
  } finally {
    logBlock('screen at teardown', renderer.screen().split('\n').slice(-24).join('\n'))
    log(`session.isLive() before kill: ${session.isLive()}`)
    child.kill('SIGTERM')
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    log(`child exit: ${JSON.stringify(code)}`)
  }
}

async function modeOrphan(): Promise<void> {
  log('MODE orphan — (b) does a BunTerminalHost child outlive the driver process?')
  const renderer = await makeRenderer()
  const child = await spawnUnderBunHost(HARNESS_ARGV, renderer)
  await reachComposer(child, renderer)
  log(`hostSupportsAdoption(BunTerminalHost) = ${hostSupportsAdoption(new BunTerminalHost())}`)
  log(`child.paneHandle = ${JSON.stringify(child.paneHandle)} — project-session.ts:175-179 refuses a session without one`)
  log(`child.detach is ${typeof child.detach} on this host`)
  writeFileSync(join(outDir, 'orphan.pid'), String(child.pid))
  log(`driver exiting WITHOUT kill(); pid ${child.pid} written to orphan.pid — the shell checks whether it survives`)
  process.exit(0)
}

async function modeApproval(): Promise<void> {
  const outside = extra
  if (!outside) throw new Error('approval mode needs <outside-file>')
  log(`MODE approval — (c) ask the TUI to write outside the workspace: ${outside}`)
  const renderer = await makeRenderer()
  const since = Date.now()
  const child = await spawnUnderBunHost(HARNESS_ARGV, renderer)
  const session = new CodexProjectSession('spike978', `bun-pid:${child.pid}`, 'started', child)
  try {
    const { ready } = await reachComposer(child, renderer)
    if (!ready) throw new Error('composer never became ready')
    // The sandbox is workspace-write with /tmp NOT excluded (measured in turn_context),
    // so the escalation target must be outside BOTH the workspace and /tmp.
    const prompt = `Run this exact shell command and nothing else: printf 'approved-978\\n' > ${outside} . Do not use any other tool, do not ask me a question first, and if the sandbox refuses, request the escalated permission. Then reply with exactly: DONE`
    log(`[probe gapped submit] ${JSON.stringify(prompt)}`)
    log('(production session.submitLine is NOT used here: measured 4/4 not submitted by the TUI)')
    void session
    await gappedSubmit(child, prompt)
    let threads: Array<{ id: string; rollout_path: string }> = []
    for (const d = Date.now() + 40000; Date.now() < d && threads.length === 0; await Bun.sleep(500)) threads = newThreadsFor(projectCwd, since)
    if (threads.length === 0) throw new Error('no codex thread started for the approval prompt')
    const rollout = threads[0]!.rollout_path
    log(`thread ${threads[0]!.id}; rollout ${rollout}`)
    const tc = readEvents(rollout).find((e) => e.type === 'turn_context')?.payload
    log(`turn_context: approval_policy=${JSON.stringify(tc?.approval_policy)} sandbox=${JSON.stringify(tc?.sandbox_policy)}`)

    // Watch for an approval dialog on the screen OR task completion, whichever first.
    // The dialog's exact shape is not known in advance, so EVERY changed screen goes
    // to the transcript and the answer fires on a numbered selector that mentions
    // allowing/approving — the same shape the trust prompt uses.
    const deadline = Date.now() + 240000
    let approved = false
    let sawDialog = false
    let lastScreen = ''
    const isDialog = (s: string) => /(?:^|\n)\s*(?:›\s*)?1\.\s/m.test(s) && /(allow|approv|yes)/i.test(s) && !/Do you trust the contents/.test(s)
    while (Date.now() < deadline) {
      const screen = renderer.screen()
      const events = readEvents(rollout)
      if (screen !== lastScreen) {
        lastScreen = screen
        logBlock('screen change', screen.split('\n').slice(-18).join('\n'))
      }
      if (!sawDialog && isDialog(screen)) {
        sawDialog = true
        const approvalEvents = events.filter((e) => JSON.stringify(e).toLowerCase().includes('approval'))
        log(`APPROVAL DIALOG detected on screen; rollout events mentioning approval so far: ${approvalEvents.length}`)
        for (const e of approvalEvents.slice(-3)) log(`  ${redact(JSON.stringify(e)).slice(0, 400)}`)
        await Bun.sleep(700)
        log('probe answers the dialog: Enter (the highlighted first option)')
        child.writeKey?.('enter')
        approved = true
      }
      if (taskCompletes(events).length > 0) break
      await Bun.sleep(400)
    }
    const events = readEvents(rollout)
    log(`task_complete count: ${taskCompletes(events).length}; approval dialog seen on screen: ${sawDialog}; probe sent approval: ${approved}`)
    log(`last AgentMessage: ${JSON.stringify(agentMessages(events).at(-1) ?? '(none)')}`)
    const written = existsSync(outside) ? readFileSync(outside, 'utf8') : null
    log(`outside file exists: ${written !== null}; contents: ${JSON.stringify(written)}`)
    const approvalEvents = events.filter((e) => JSON.stringify(e).toLowerCase().includes('approval'))
    log(`rollout events mentioning "approval": ${approvalEvents.length}`)
    for (const e of approvalEvents.slice(0, 6)) log(`  ${redact(JSON.stringify(e)).slice(0, 500)}`)
    const cmds = events.filter((e) => e.type === 'event_msg' && e.payload?.type === 'item_completed' && e.payload.item?.type === 'CommandExecution')
    for (const c of cmds) log(`  CommandExecution: ${redact(JSON.stringify(c.payload.item)).slice(0, 500)}`)
    logBlock('final screen', renderer.screen().split('\n').slice(-24).join('\n'))
    writeFileSync(join(outDir, 'rollout-approval.jsonl'), redact(readFileSync(rollout, 'utf8')))
  } finally {
    child.kill('SIGTERM')
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => 'timeout' as const)])
    log(`child exit: ${JSON.stringify(code)}`)
  }
}

const modes: Record<string, () => Promise<void>> = { refuse: modeRefuse, turns: modeTurns, orphan: modeOrphan, approval: modeApproval }
const run = modes[mode]
if (!run) {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
log(`codex: ${(await Bun.$`codex --version`.text()).trim()}; bun ${Bun.version}; cwd=${projectCwd}`)
try {
  await run()
  log('PROBE END')
  process.exit(0)
} catch (error) {
  log(`PROBE FAILED: ${(error as Error).stack ?? String(error)}`)
  process.exit(1)
}
