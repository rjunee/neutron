// persistent-repl-substrate.ts → spawn.ts
// Session spawn / resume / turn-inject machinery + the respawn in-flight gate
// (D2 split).

import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../substrate.ts'
import { type DeadTurnNotice, startApi5xxDeadTurnWatcher } from './api5xx-dead-turn-watcher.ts'
import { buildReplArgv } from './build-repl-argv.ts'
import { buildSettings } from './build-settings.ts'
import { bunTerminalHost } from './bun-terminal-host.ts'
import { ChannelWedgedSpawnError, MAX_FLEET_RESPAWNS, buildChannelWedgeCapAlertText, runBoundedChannelWedgeRespawn } from './channel-unbound-respawn.ts'
import { ensureClaudeTrust } from './ensure-claude-trust.ts'
import { type InFlightGate, makeInFlightGate } from './in-flight-gate.ts'
import { childByKey, pool, replToolBridgeRef, respawnGates, sink } from './pool-state.ts'
import {
  registerLiveProcessSafe,
  type LiveProcessHandle,
} from '@neutronai/tools/process-registry.ts'
import { assertReplAlive } from './post-spawn-assertion.ts'
import type { PtyChild } from './pty-host.ts'
import { RATE_LIMIT_BANNER_SEVERITIES, createRateLimitBannerDetector } from './rate-limit-banner.ts'
import { createAuthFailureDetector } from './auth-failure-signature.ts'
import { type ReplRegistryRecord, getRecord, patchRecord, withRegistry } from './repl-registry.ts'
import { resolveRespawnStrategy } from './respawn-strategy.ts'
import { createResumePickerDetector } from './resume-picker-detector.ts'
import { captureSession, makeJsonlExistsProbe } from './session-capture.ts'
import { measurePostCompactSize, sessionJsonlPath, startSessionSizeWatchdog } from './session-size-watchdog.ts'
import { dashifyCwd } from './session-validation.ts'
import { createWedgedPromptDetector } from './interactive-prompt-deadlock-detector.ts'
import { COMPACT_RESUME_FULL_RE, COMPACT_RESUME_SUMMARY_RE, DEFAULT_AGENT_BASE_PROMPT, DEFAULT_DEV_CHANNEL_PATH, DEFAULT_TOOLS_BRIDGE_PATH, DEV_CHANNEL_DISCLAIMER_RE, DISCLAIMER_BOTTOM_N, RATE_LIMIT_OPTIONS_BOTTOM_N, RATE_LIMIT_OPTIONS_DEBOUNCE_MS, RATE_LIMIT_OPTIONS_RE, RATE_LIMIT_STOP_RE, SESSION_COMPACT_IDLE_QUIESCE_MS, TOOLS_BRIDGE_SERVER_NAME, TOOL_USE_QUESTION_RE, TOOL_USE_SELECTOR_RE, resolveTranscriptProjectsDir, runOutputScan, sendKey, surfaceSizeAlert } from './signatures.ts'
import type { PersistentReplSubstrateOptions, ResumeDirective } from './types.ts'
import { ReplSession, authFingerprintFor, httpHealth, mergeEnv, terminateChild, unlinkSessionConfigs } from './repl-session.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

async function spawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  resume?: ResumeDirective,
): Promise<ReplSession> {
  sink.ensureStarted()
  const cwd = options.cwd ?? process.cwd()
  const model = spec.model_preference[0]
  if (model === undefined) {
    throw new Error('persistent-repl: model_preference is empty; at least one model required')
  }
  // Respawn-is-always-resume (brief § 0 / § 2): when a resume directive is
  // present (from the registry on a post-crash next-turn, or from the watchdog /
  // admin respawn actuation), re-attach the captured session UUID via `--resume`
  // instead of cold-spawning a fresh `--session-id`. This is the wiring that
  // closes the S1 context-loss gap.
  const sessionId = resume?.sessionId ?? (options.idGen ?? randomUUID)()
  // 16 bytes, not 4 (adversarial security review 2026-07-20). This value names
  // the per-session config files below, and one of them carries the MCP sink
  // TOKEN in plaintext. 4 bytes is guessable/squattable by any same-uid process;
  // the path is also visible in `ps` because `--mcp-config <path>` is on argv.
  const channelName = `neutron-${randomBytes(16).toString('hex')}`
  const ptyHost = options.ptyHost ?? bunTerminalHost
  const devChannelPath = options.devChannelPath ?? DEFAULT_DEV_CHANNEL_PATH
  const toolsBridgePath = options.toolsBridgePath ?? DEFAULT_TOOLS_BRIDGE_PATH
  const appendSystemPromptFile = options.appendSystemPromptFile ?? DEFAULT_AGENT_BASE_PROMPT

  // Per-session config files (mcp-config wires the dev-channel; settings wires
  // the enforce-reply Stop hook).
  //
  // OWNER-ONLY DIRECTORY (adversarial security review 2026-07-20). These were
  // previously written directly into a shared `tmpdir()` — the mcp-config at the
  // process umask (no mode argument at all) — and it carries the MCP sink TOKEN
  // in plaintext. Any same-uid process could read it and then dispatch tools
  // against the bridge. A 0700 per-spawn directory plus 0600 files keeps the
  // token owner-readable; the wider bridge-auth fix (per-session token, session
  // check before dispatch) is tracked separately.
  const cfgDir = join(tmpdir(), `neutron-repl-${channelName}`)
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 })
  const cfgBase = join(cfgDir, 'session')
  const mcpConfigPath = `${cfgBase}-mcp.json`
  const settingsPath = `${cfgBase}-settings.json`
  const toolsManifestPath = `${cfgBase}-tools.json`

  // P0-1 — the dev-channel reply sink is ALWAYS present (`server:<name>`). When
  // this REPL opted into the tool bridge AND a `ReplToolBridge` is wired AND the
  // registry exposes ≥1 tool, add a SECOND `mcpServers` entry: a stdio bridge
  // fronting the in-process `ToolRegistry`. We SNAPSHOT the tool schemas to a
  // manifest file NOW (the registry is fully populated post-compose) so the
  // bridge's discovery is deterministic + race-free. `toolBridgeActive` gates the
  // `--allowedTools` namespace below.
  const mcpServers: Record<string, unknown> = {
    [channelName]: {
      command: 'bun',
      args: [devChannelPath],
      env: {
        SINK_PORT: String(sink.port),
        SINK_TOKEN: sink.token,
        SESSION_ID: sessionId,
        CHANNEL_NAME: channelName,
      },
    },
  }
  let toolBridgeActive = false
  const toolBridge = replToolBridgeRef.current
  if (options.enableToolBridge === true && toolBridge !== undefined) {
    const schemas = toolBridge.listToolSchemas()
    if (schemas.length > 0) {
      writeFileSync(toolsManifestPath, JSON.stringify(schemas, null, 2))
      mcpServers[TOOLS_BRIDGE_SERVER_NAME] = {
        command: 'bun',
        args: [toolsBridgePath],
        env: {
          SINK_PORT: String(sink.port),
          SINK_TOKEN: sink.token,
          SESSION_ID: sessionId,
          TOOLS_MANIFEST_PATH: toolsManifestPath,
          BRIDGE_SERVER_NAME: TOOLS_BRIDGE_SERVER_NAME,
        },
      }
      toolBridgeActive = true
    }
  }

  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 })
  // Task 6 (T5 write-containment) — forward the optional `permissions` block onto
  // the per-session settings write so a ritual write-containment REPL's deny rules
  // land in `--settings`. Absent ⇒ the Stop-hook-only write, unchanged.
  buildSettings({
    settingsPath,
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  })

  // SECURITY-CRITICAL (Codex-r1-P1): thread the spec's declared tool surface into
  // the REPL spawn so the persistent path honors `tools: []` exactly like the
  // retired per-turn path did. An empty surface → `--tools ""` (no built-in tools),
  // closing the prompt-injection vector for untrusted-content callers (history-
  // import) running under `--dangerously-skip-permissions`. The tool surface is a
  // SPAWN-time property of the REPL; the reuse guard below refuses to serve a turn
  // whose surface differs from the warm REPL's, so a less-privileged (e.g. import)
  // turn can never bleed onto a more-privileged warm session.
  const toolSurface = spec.tools.map((t) => t.name)
  const argv = buildReplArgv({
    ...(options.claude_bin !== undefined ? { claudeBin: options.claude_bin } : {}),
    sessionId,
    resume: resume !== undefined,
    channelName,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile,
    model,
    addDir: cwd,
    tools: toolSurface,
    // P0-1 — when the tool bridge is attached, permit its MCP namespace so the
    // agent can invoke the Neutron tools without a per-call approval prompt.
    // `--tools` only gates the BUILT-IN set, so the security-critical
    // `--tools ""` for untrusted-content REPLs is untouched; this allow-list is
    // the MCP-tool permission grant (`mcp__neutron`), added ONLY here.
    ...(toolBridgeActive ? { allowedMcpTools: [`mcp__${TOOLS_BRIDGE_SERVER_NAME}`] } : {}),
    ...(options.skip_permissions !== undefined ? { skipPermissions: options.skip_permissions } : {}),
  })

  // Construct + register the session BEFORE spawning so a fast /channel-ready
  // POST from the dev-channel can never race ahead of the sink registration.
  const session = new ReplSession(sessionKey, sessionId, channelName)
  session.toolSurface = toolSurface.join(',')
  // Stamp the active project scope this REPL serves (folded into the pool key, so
  // it is stable for the session's whole lifetime). The `/tool-call` sink reads
  // it to bind the active project into a tool dispatch — see `ReplSession.projectId`.
  session.projectId = options.project_id
  // P0-1 — stamp the bridge attachment so the reuse guard can refuse a
  // bridge-mismatched turn (matches the `requestedToolBridge` computation).
  session.toolBridgeActive = toolBridgeActive
  // Stash the temp config paths so teardown can unlink them (Argus r5 IMPORTANT —
  // ephemeral one-shots write a fresh pair per call; leaked otherwise). The tools
  // manifest is only written when the bridge is active; include it when so.
  session.configPaths = toolBridgeActive
    ? [mcpConfigPath, settingsPath, toolsManifestPath]
    : [mcpConfigPath, settingsPath]
  // Stamp the auth fingerprint the child is being spawned with so the warm-reuse
  // freshness guard can evict on a same-credential-id token refresh (Codex r2 P1).
  session.authFingerprint = authFingerprintFor(options.env)
  sink.register(sessionId, session)

  // Pre-seed the first-run trust + bypass-permissions acceptance so the
  // interactive REPL doesn't wedge on a blocking Ink dialog before it loads
  // the dev-channel MCP server (the `no-channel-ready` failure class).
  const childEnv = mergeEnv(options.env)
  // Force `claude` to load the `--mcp-config` dev-channel SYNCHRONOUSLY (await the
  // stdio MCP connect group at startup) instead of its default async, non-blocking
  // load. `claude`'s loader reads `MCP_CONNECTION_NONBLOCKING`: an explicit
  // FALSE-like value (`false`/`0`/`no`/`off`) forces the blocking path so the
  // single dev-channel server is connected + handshaken before the REPL accepts
  // its first input. The REPL's `--mcp-config` contains ONLY that one server, so
  // blocking has no collateral slowdown; startup is already budgeted by the
  // post-spawn assertion. This makes the dev-channel's `/channel-bound` signal
  // (its `mcp.oninitialized` hook) land promptly, tightening the Stage-4 gate.
  //
  // HISTORICAL NOTE (P0, 2026-06-26): this env was originally added by #79 as the
  // claimed root-cause fix for `channel-wedged`, on the theory that the first turn
  // was injected before the stdio handshake bound the channel. That theory was
  // WRONG — reproduced live under the real Bun PTY harness, the handshake
  // completes cleanly and the channel `reply()`s fine; the real bug was the
  // post-spawn assertion false-failing on the always-present
  // "no MCP server configured with that name" TUI warning (claude 2.1.186 prints
  // it even for a fully-wired channel). The real fix is the `/channel-bound`
  // protocol gate in `post-spawn-assertion.ts`. This env is kept as a harmless,
  // mildly-helpful belt-and-suspenders (bind sooner), NOT as the fix. Set
  // UNCONDITIONALLY so a host-leaked `MCP_CONNECTION_NONBLOCKING=true` can't
  // re-introduce an async-load window.
  childEnv['MCP_CONNECTION_NONBLOCKING'] = 'false'
  if (options.skipTrustSeed !== true) {
    const trustInput: Parameters<typeof ensureClaudeTrust>[0] = { cwd }
    if (options.claudeConfigDir !== undefined) trustInput.configDir = options.claudeConfigDir
    ensureClaudeTrust(trustInput)
  }
  if (options.claudeConfigDir !== undefined) {
    childEnv['CLAUDE_CONFIG_DIR'] = options.claudeConfigDir
  }

  // F3 output-scan tick: the `--dangerously-load-development-channels` flag
  // renders a first-run disclaimer ("…using this for local development?") that
  // has NO config seed (unlike trust + bypass) and BLOCKS MCP-server loading
  // until dismissed; its default-selected option IS the accept, so a single
  // Enter clears it. We GENERALIZE that one-off check into a registered detector
  // on the session's `OutputScanner` (F3) rather than a competing scan loop —
  // the P0/P1 recovery detectors register the same way in follow-on PRs. Without
  // this dismiss the spawn wedges `no-channel-ready` forever.
  session.scanner.register({
    id: 'dev-channel-disclaimer',
    bottomN: DISCLAIMER_BOTTOM_N,
    present: (ctx) => DEV_CHANNEL_DISCLAIMER_RE.test(ctx.normalized),
    keys: ['enter'],
  })
  // P0 wedged-interactive-prompt detect+recover (master-table row #1). An
  // `AskUserQuestion` / arrow-menu rendered mid-turn deadlocks the REPL with no
  // keystroke path from chat; rather than let the inactivity watchdog KILL the
  // agent, this detector (footer + live `^❯` cursor + 2-tick stability + the
  // framework's doc-quote guard) trips the bounded escape→escape→ctrl-c recovery
  // ladder in `runOutputScan` (it carries no `keys` — recovery is a verify
  // ladder, never an auto-pick).
  session.scanner.register(createWedgedPromptDetector())
  // P1: auto-approve CC's tool-use permission prompt. BOTH cues required
  // (question + `❯ 1. Yes` selector) — single-cue matching false-fires on
  // scrollback. `1`+`enter` selects "Yes". The framework stamps the latch +
  // 5s debounce BEFORE returning the fired detection, so this keystroke is
  // fire-once per rising edge — a transport failure can NOT retry and risk a
  // DOUBLE-Enter onto the approval (output-scan.ts invariant §4).
  //
  // KNOWN LIMITATION (substrate-level, not specific to this detector): the F1
  // ring is an append-only byte log, so a just-approved prompt's text lingers
  // in the bottom-N window until enough new output scrolls it out. If a second
  // prompt renders with < bottomN lines of intervening output the latch may
  // still be up, so it won't see a fresh rising edge until the prior signature
  // clears. We deliberately do NOT mitigate in-detector: a tighter positional
  // window would MISS live prompts (the `❯ 1. Yes` selector sits ABOVE its
  // 2./3. option lines — the widened-window Robobuddha lesson), and a timed
  // re-fire would inject a stray `1`+enter into a live session. The proper fix
  // is substrate-level (a rendered-screen ring or latch-clear-on-fresh-data);
  // the P0 wedge-recovery detector (#1) is the backstop for a genuinely-stuck
  // prompt. Flagged by Codex cross-model review; tracked for the broader port.
  //
  // TASK 6 (T5 write-containment) — GATE this ONE detector behind
  // `disableToolUseAutoApprove`. A ritual write-containment REPL pairs
  // `skip_permissions: false` + a `permissions.deny` rule; leaving the
  // auto-approver ON would make the deny THEATER (CC renders the approval prompt,
  // this detector presses "Yes", the write succeeds). Disabling it makes the deny
  // load-bearing — the prompt (if any) is left for the WEDGED-PROMPT recovery
  // ladder (#1, registered above, ALWAYS on) so a genuine deadlock still
  // self-clears. Every OTHER detector stays unconditionally registered.
  if (options.disableToolUseAutoApprove !== true) {
    session.scanner.register({
      id: 'tool-use-approve',
      debounceMs: 5000,
      present: (ctx) =>
        TOOL_USE_QUESTION_RE.test(ctx.normalized) && TOOL_USE_SELECTOR_RE.test(ctx.normalized),
      keys: ['1', 'enter'],
    })
  }
  // P1: /rate-limit-options org-cap auto-stop (master-table row #4). When the
  // Claude org hits its monthly usage cap, CC injects an interactive picker that
  // blocks the REPL until an option is chosen. Ryan 2026-05-23 directive: "I need
  // you to handle when this pane appears. Just select stop and wait for limit to
  // reset." Option 3 = "Stop and wait for limit to reset", so `3`+`enter` selects
  // it (position-independent — pressing `3` highlights option 3 regardless of the
  // cursor's resting row).
  //
  // The positional bottom-30 guard (`RATE_LIMIT_OPTIONS_BOTTOM_N`) is LOAD-
  // BEARING and unique to this detector: pressing `3` STOPS CC, so NO new output
  // scrolls the picker text away afterward — it just sits in the ring until the
  // monthly cap resets. Without the bottom-N window the stale picker text would
  // satisfy `present` on every later tick and `select-stop` would re-inject
  // `3`+Enter into the dead input for days (Vajra PR #132 r1). Once CC has
  // stopped, idle whitespace / a shell prompt pushes the picker text up past the
  // bottom-30 threshold, which lets the detector correctly STOP firing. The
  // framework's bottom-N windowing (`buildDetectorContext`) provides this guard;
  // the latch + debounce-before-await make the `3`+enter fire-once per rising
  // edge (invariant §4) so a transport failure can't double-send.
  //
  // The Vajra "cheap viewport pre-check gates the recapture" lesson (Argus PR
  // #132 r3 BLOCKER — an unconditional `tmux capture-pane -S -100` was ~120 extra
  // captures/min) is architecturally obviated here: Neutron's ring is an
  // in-memory byte log, so the bottom-N read (`bottomNLines`) is already the
  // cheap viewport check — there is no separate scrollback recapture to gate.
  session.scanner.register({
    id: 'rate-limit-options-stop',
    bottomN: RATE_LIMIT_OPTIONS_BOTTOM_N,
    debounceMs: RATE_LIMIT_OPTIONS_DEBOUNCE_MS,
    present: (ctx) =>
      RATE_LIMIT_OPTIONS_RE.test(ctx.normalized) && RATE_LIMIT_STOP_RE.test(ctx.normalized),
    keys: ['3', 'enter'],
  })
  // P1: clear CC's compact-resume picker (the summary-vs-full menu shown when
  // resuming an auto-compacted session). EXACT-STRING match on one of the two
  // literal option labels — NOTHING broader. A prior broad
  // `summary+full+numbered` match fired on NORMAL conversation and injected
  // `2<Enter>` into live panes; the picker is ARROW-driven, not number-key, so
  // the action is `down`+`enter` (select "Resume full session as-is"), never a
  // digit. The framework stamps the latch + 5s debounce BEFORE returning the
  // fired detection, so this is fire-once per rising edge (invariant §4). The
  // append-only-ring back-to-back limitation noted on `tool-use-approve` applies
  // here too; the P0 wedge-recovery detector is the backstop.
  session.scanner.register({
    id: 'compact-resume-picker',
    debounceMs: 5000,
    present: (ctx) =>
      COMPACT_RESUME_SUMMARY_RE.test(ctx.normalized) || COMPACT_RESUME_FULL_RE.test(ctx.normalized),
    keys: ['down', 'enter'],
  })
  // P2: resume-session-failure picker safety net (master-table row #7). When
  // `--resume <stale-id>` is started against a session id that no longer exists,
  // CC drops into an interactive "Resume Session" picker that BLOCKS the REPL.
  // The hard-won lesson is ESCAPE-THEN-RECOVER, never BLIND-ANSWER: a stale
  // cached session_id must NOT silently spawn a fresh (empty-context) session
  // without a disk-recovery attempt + a user-visible "session lost" notice. This
  // detector carries NO `keys` (recovery is the escape-then-disk-scan ladder in
  // `dispatchResumePickerRecovery`, not a fire-once keystroke); it anchors on the
  // distinctive `Resume Session` title + the `Esc to clear` footer (which
  // distinguishes it from the AskUserQuestion `esc to cancel` menu detector #1
  // handles, so the two never collide). LARGELY OBVIATED by Neutron's JSONL-first
  // resume (`session-respawn.ts`/`session-validation.ts`), which avoids the picker
  // in the normal path — this is a pure safety net for if it ever appears.
  session.scanner.register(createResumePickerDetector())
  // P2: rate-limit / overload BANNER alert (master-table row #10). DISTINCT from
  // the `rate-limit-options-stop` detector above — that PRESSES `3` on the
  // interactive ORG-CAP picker; THIS passively notices the temporary / usage-cap
  // BANNER CC prints and edge-fires a NOTIFY-ONLY alert (no keystroke, no
  // auto-retry — those are row #4's job). One detector per severity, so the
  // framework's per-detector edge-latch IS the Vajra `${threadId}::${severity}`
  // latch: fire on absent→present, clear ONLY on present→absent. THIS is the fix
  // for the bug a pure time-dedupe caused — re-firing the alert HOURLY FOREVER on a
  // stale banner sitting in an idle pane. Guards: the framework's doc-quote strip +
  // bottom-30 window, plus the detector's own not-at-idle-prompt walk (which skips
  // bypass-permissions / "new task?" / box-drawing chrome so a retired 429 above
  // the chrome doesn't false-fire — book topic, 4 alerts 2026-05-15). Carries NO
  // `keys`; `runOutputScan` routes a fired banner to `dispatchRateLimitBannerNotice`.
  for (const severity of RATE_LIMIT_BANNER_SEVERITIES) {
    session.scanner.register(createRateLimitBannerDetector(severity))
  }
  // CLI AUTH-FAILURE signature (2026-07-24 dogfood). DISTINCT from the rate-limit
  // banner: that surfaces a transient/usage-cap LIMIT; this notices an INVALID /
  // EXPIRED CREDENTIAL (`OAuth access token is invalid` / `Please run /login` / a
  // 401·403 `API Error`) the `claude` child prints before going silent headless.
  // NOTIFY-ONLY (no `keys` — there is nothing to press): `runOutputScan` routes a
  // fire to `dispatchAuthFailureNotice`, which records the session's auth-invalid
  // state so the driver's timeout watchdog fails the turn as `auth_invalid` (a
  // reconnect prompt) instead of the useless generic freeze-timeout.
  session.scanner.register(createAuthFailureDetector())
  // The spawn `const child` isn't assigned when the `onData` closure is defined,
  // so route fired-detector keystrokes through this mirror (set right after
  // spawn, before any onData can fire on the event loop).
  let scanChild: PtyChild | undefined
  // F4 — the ambient live-process handle for THIS child, assigned right after the
  // register call below (before any onData can fire on the event loop). It is
  // bound to the owning registry + this child's (name, pid), so a late touch from
  // this child can never refresh a different registry or a respawned successor.
  let liveHandle: LiveProcessHandle | undefined

  const child = ptyHost.spawn(argv, {
    cwd,
    env: childEnv,
    onData: (chunk) => {
      session.ring.append(Buffer.from(chunk).toString('utf8'))
      const now = Date.now()
      session.lastDataAt = now
      // F4 — feed the watchdog's live-process view: any child output is activity,
      // so keep the ProcessRegistry entry fresh. NOTE this is `last_activity_at`
      // ONLY — it is NOT what stuck-agent measures. Stuck is `busy_since` (an
      // OUTSTANDING dispatched turn, marked from pool.ts), because for a
      // request/response REPL silence between turns is the normal resting state,
      // so output-age judged every healthy warm session stuck. Guarded no-op when
      // no ambient registry is registered; the handle identity-guards so it only
      // ever touches THIS child's entry.
      liveHandle?.touch()
      const target = scanChild
      if (target === undefined) return
      // Run the registered detectors against the ring and actuate the ones that
      // fired on the rising edge (disclaimer Enter, wedged-prompt recovery, …).
      // `scan` stamps each detector's latch BEFORE returning, so the keystroke
      // write is fire-once even if the transport throws — a failed write can't
      // retry next tick and double-send onto an approval prompt (invariant §4).
      runOutputScan(session, target, options, now)
    },
  })
  scanChild = child
  session.attachChild(child)
  // Synchronous handle mirror so a respawn can detect alive-but-wedged without
  // awaiting the pool promise (Argus r3 BLOCKER 1). Newest spawn wins the key.
  childByKey.set(sessionKey, child)
  // F4 — publish this child's PID into the watchdog's live-process view (the
  // single PTY chokepoint serves BOTH the pooled REPL and the ephemeral/dispatch
  // children, so ONE writer here covers every spawn site). UPSERT-safe against a
  // respawn re-using `sessionKey`; unregistered in `child.exited` below. Guarded
  // no-op when no ambient ProcessRegistry is registered (unit tests / LLM-less).
  liveHandle = registerLiveProcessSafe({
    name: sessionKey,
    pid: child.pid,
    tool_name: 'cc-repl',
    meta: { session_id: sessionId, channel: channelName },
  })
  // Publish the handle on the session so the DISPATCH site (pool.ts) can declare
  // a turn outstanding / settled. That outstanding-turn window — NOT this child's
  // output age — is what stuck-agent detection measures, so an idle warm REPL
  // between turns is correctly never stuck.
  session.liveHandle = liveHandle

  // Master-table row #11: start the per-turn API-5xx dead-turn JSONL watcher for
  // THIS child's transcript. A mid-turn 5xx (`Overloaded`/`internal_server_error`
  // /`rate_limit_error`) aborts the turn before `reply()`, so the substrate's
  // `completion` never resolves and the user sees NOTHING (Ryan 2026-06-16). The
  // watcher tails the transcript JSONL and edge-fires a "resend your last message"
  // notice through `onDeadTurnNotice` (default: a structured stderr notice — no
  // feature flag, ON by default). sessionId + cwd are both known here, so the
  // `<projectsDir>/<dashifyCwd(cwd)>/<sessionId>.jsonl` path resolves immediately
  // (session-validation.ts layout). Resolve the transcript root the SAME way the
  // JSONL ghost gate does (`makeJsonlExistsProbe(options.projectsDir)` below): an
  // explicit `options.projectsDir` wins (custom / per-instance transcript root —
  // Codex P2), then `CLAUDE_CONFIG_DIR`'s `projects` (CC writes transcripts there
  // when `claudeConfigDir` is set), then the default `~/.claude/projects`.
  const projectsDir = resolveTranscriptProjectsDir(options)
  const deadTurnNotify =
    options.onDeadTurnNotice ??
    ((notice: DeadTurnNotice): void => {
      process.stderr.write(
        `[repl-api5xx] dead turn on session=${sessionId.slice(0, 8)} matched=${notice.matched} — user should resend last message\n`,
      )
    })
  session.deadTurnWatcher = startApi5xxDeadTurnWatcher({
    jsonlPath: join(projectsDir, dashifyCwd(cwd), `${sessionId}.jsonl`),
    notify: deadTurnNotify,
  })

  // Wire process death → fail in-flight turn + evict from pool so the next
  // start() respawns. Leaves cleanup to GC; the dev-channel SIGTERMs itself.
  // IDENTITY-GUARDED: a respawn re-attaches the SAME sessionId/sessionKey, so a
  // dying OLD child must not evict the NEW session a concurrent respawn already
  // installed (the resume race the P2-3 regression caught).
  fireAndForget('spawn.then', child.exited.then(async (exitCode) => {
    session.onDeath()
    // Detach the row-#11 dead-turn JSONL watcher — this child's transcript is now
    // terminal; a respawn starts a fresh watcher for the new child.
    session.deadTurnWatcher?.stop()
    session.deadTurnWatcher = undefined
    // Stop the size-watchdog cadence — the child it watched is gone (row #13).
    session.sizeWatchdog?.stop()
    // F4 — reconcile the watchdog's live-process view against this real exit,
    // distinguishing a CLEAN/EXPECTED exit from a CRASH so CrashedAgentDetector can
    // actually observe crashes in production (a child that exits between 30 s ticks
    // must not be silently dropped before the detector runs). The handle is bound
    // to the OWNING registry + this child's (name, pid), so BOTH branches no-op if
    // a concurrent respawn already replaced `sessionKey`, or a newer gateway boot
    // pushed a different ambient registry — it can only ever touch THIS child's own
    // entry (High 2). CLEAN = code 0 or a termination WE initiated (SIGTERM/SIGKILL
    // on evict/respawn/cancel/shutdown → `wasKilledByUs`): unregister outright.
    // CRASH = a non-zero code or an EXTERNAL signal we did not send: mark the record
    // crashed and LEAVE it so the detector reports it once and reaps it on commit.
    const killedByUs = child.wasKilledByUs?.() ?? false
    if (!killedByUs && exitCode !== 0) {
      liveHandle?.markCrashed()
    } else {
      liveHandle?.unregister()
    }
    sink.unregisterIf(sessionId, session)
    // Reclaim the temp config files now the child is gone (covers pool eviction,
    // crash, and shutdown — the ephemeral dispose path unlinks eagerly too).
    unlinkSessionConfigs(session)
    // Drop the synchronous handle mirror only if it still points at THIS child —
    // a concurrent respawn may have already installed a fresh one for the key.
    if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
    const pooled = pool.get(sessionKey)
    if (pooled !== undefined) {
      try {
        if ((await pooled) === session) pool.delete(sessionKey)
      } catch {
        pool.delete(sessionKey)
      }
    }
  }))

  // Post-spawn assertion: child alive → /channel-ready (transport attached) →
  // HTTP /health → /channel-bound (MCP handshake complete).
  const assertion = await assertReplAlive(
    { pid: child.pid },
    {
      isChildAlive: () => !child.hasExited(),
      getChannelPort: () => session.channelPort,
      hasHttpHealth: (port) => httpHealth(port),
      // Stage 4 (channel-MCP-bound, port row #6): the dev-channel posts
      // `/channel-bound` from `mcp.oninitialized` once claude completes the MCP
      // handshake — the TRUE readiness gate, replacing the false-positive "no MCP
      // server configured with that name" TUI scan (claude 2.1.186 always prints
      // that warning even for a fully-wired, working channel).
      isChannelBound: () => session.channelBound,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
    },
    options.assertConfig ?? {},
  )
  if (!assertion.ok) {
    if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
    sink.unregister(sessionId)
    // channel-wedged is owned by the bounded-respawn wrapper (port row #6): throw
    // the TYPED error and DON'T pool.delete here — the wrapper holds the pool
    // entry and either retries on the same key or propagates the cap, so deleting
    // it mid-loop would orphan a successful retry's warm session. Every OTHER
    // reason keeps the original kill-and-throw (the wrapper passes it straight
    // through as a non-wedged failure, no retry).
    if (assertion.reason === 'channel-wedged') {
      // AWAIT the wedged child's exit (graceful SIGTERM→await→SIGKILL) BEFORE the
      // wrapper launches the next attempt: on a supervised/resume spawn a
      // SIGTERM-slow old `claude` must not overlap a new `claude --resume` on the
      // same transcript (the one-owner-per-transcript invariant). Codex r1 [P1].
      await terminateChild(child)
      throw new ChannelWedgedSpawnError(sessionKey, assertion.detail)
    }
    child.kill()
    pool.delete(sessionKey)
    throw new Error(`persistent-repl: spawn failed (${assertion.reason}; ${assertion.detail ?? ''})`)
  }

  // Vajra port row #13: start the warm-session size watchdog now the REPL is
  // verified alive. It measures the POST-COMPACT JSONL size (bytes after the last
  // `"isCompactSummary":true` marker — NEVER raw `stat.size`, or "Compact does
  // nothing" re-fires forever) on a cadence and surfaces a Reset/Compact
  // affordance before the transcript grows large enough to block `--resume` (the
  // 2026-04-16 11.8 MB infinite-restart incident). `requestCompact()` actuates
  // `escape` + `/compact\r` through the same PTY write seam the disclaimer-dismiss
  // path uses, behind the surfaced affordance (see `requestSessionCompact`). The
  // timer is unref'd and stopped on child exit / teardown.
  //
  // POLICY (gap #4): the surfaced alert alone is a dead end on Open's WS-native
  // web chat — there is no inline keyboard and `requestSessionCompact` has no
  // caller, so the single-owner session would just keep growing until `--resume`
  // wedges. We therefore wire `isIdle` so the watchdog idle-gates an AUTOMATIC
  // compaction at the critical band: it injects the SAME `escape`+`/compact` the
  // affordance surfaces, but ONLY when no turn is in flight AND the PTY has been
  // quiet ≥ SESSION_COMPACT_IDLE_QUIESCE_MS (never mid-turn). Edge-latched +
  // debounced in the watchdog so a still-large session can't re-fire. NOT a
  // feature flag — the policy is on wherever a live PTY child is wired.
  session.sizeWatchdog = startSessionSizeWatchdog({
    readSize: () => measurePostCompactSize(sessionJsonlPath(sessionId, cwd, options.projectsDir)),
    surface: (severity, sizeBytes) =>
      surfaceSizeAlert(session, sessionKey, severity, sizeBytes, options),
    writeKey: (key) => sendKey(child, key),
    write: (data) => child.write(data),
    isIdle: () =>
      session.activeTurn === undefined &&
      Date.now() - session.lastDataAt >=
        (options.sizeCompactIdleQuiesceMs ?? SESSION_COMPACT_IDLE_QUIESCE_MS),
    ...(options.sizeCheckIntervalMs !== undefined ? { intervalMs: options.sizeCheckIntervalMs } : {}),
  })

  // Sprint-2 supervision: persist a registry record so this session is
  // recoverable across crash / gateway-restart. has_session starts true on a
  // resume (we already know the JSONL exists) and false on a fresh spawn (the
  // capture gate below flips it once the JSONL lands).
  if (options.replRegistryPath !== undefined) {
    // Persist the resume-picker recovery (row #7) DECISION into the durable
    // registry, not the optimistic stale-id resume (Codex P2). The recovery runs
    // mid-spawn (escape during the post-spawn assertion wait); by the time we write
    // here it may have already (a) recovered a different session from disk
    // (`pendingResumeSessionId`) or (b) found nothing (`forceFreshRespawn`). The
    // crash/watchdog respawn reads the REGISTRY, not this in-memory session — which
    // is dropped from the pool on child exit — so the decision MUST land on disk or
    // a child that exits before the next turn would re-`--resume` the stale id and
    // reopen the picker. (The recovery callbacks ALSO `patchRecord` directly, so the
    // OTHER ordering — recovery finishing AFTER this write — is covered too.)
    const recoveredSessionId = session.pendingResumeSessionId
    const recoveryForcesFresh = session.forceFreshRespawn
    const record: ReplRegistryRecord = {
      sessionKey,
      sessionId: recoveredSessionId ?? sessionId,
      cwd,
      channelName,
      has_session: recoveryForcesFresh
        ? false
        : recoveredSessionId !== undefined
          ? true
          : resume !== undefined,
      model,
      pid: child.pid,
      first_ready_at: Date.now(),
    }
    if (session.channelPort !== undefined) record.devchannel_port = session.channelPort
    try {
      // Merge onto any prior row BUT clear the transient `respawn_in_flight_at`
      // stamp: this spawn just COMPLETED the in-flight respawn, so a stale stamp
      // must not survive to block the next tick's recovery (Codex P2-3).
      withRegistry(options.replRegistryPath, (registry) => {
        const prev = registry[sessionKey]
        const { respawn_in_flight_at: _drop, ...merged } = prev ? { ...prev, ...record } : record
        registry[sessionKey] = merged
        return { registry, result: undefined }
      })
    } catch {
      // A registry write failure must never brick a live REPL; supervision
      // degrades to "no auto-resume for this session" until the next write.
    }
  }

  // Ghost-session gate (best-effort, non-blocking): confirm the JSONL lands so
  // a Sprint-2 respawn can `--resume` safely. We do NOT block the first turn on
  // it — the warm REPL is already serving. CONSUME the result (closing the S1
  // fire-and-forget gap, brief § 0): on a fresh spawn, flip the registry
  // record's `has_session` true once the transcript exists, so a future
  // respawn / next-turn-after-crash resolves to `--resume` instead of fresh.
  const jsonlProbe = options.jsonlExistsProbe ?? makeJsonlExistsProbe(options.projectsDir)
  fireAndForget('spawn.captureSession', captureSession(
    sessionId,
    cwd,
    { jsonlExists: jsonlProbe, sleep: (ms) => Bun.sleep(ms) },
    options.captureConfig ?? {},
  )
    .then((result) => {
      if (result.captured && resume === undefined && options.replRegistryPath !== undefined) {
        try {
          patchRecord(options.replRegistryPath, sessionKey, { has_session: true })
        } catch {
          /* best-effort: a registry patch failure degrades to a fresh spawn
             next time, not a fatal — kept local, not surfaced. */
        }
      }
    }))

  return session
}

/**
 * Wrap {@link spawnSession} with the channel-MCP-unwired bounded respawn (port
 * row #6). When a spawn fast-fails `channel-wedged` (dev-channel `/health` 200
 * but the MCP never bound — the agent can never `reply()`), the root cause is
 * transient spawn-time memory/CPU pressure, so a respawn usually clears it. We
 * retry up to {@link MAX_FLEET_RESPAWNS} times; if the wedge persists past the
 * cap we fire exactly ONE operator alert and give up (no infinite loop). Any
 * NON-wedged spawn failure (dead-child / no-health / …) is propagated on the
 * first attempt — this wrapper owns only the channel-wedged class.
 */
export async function spawnWithChannelWedgeRespawn(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  resume?: ResumeDirective,
): Promise<ReplSession> {
  const alert =
    options.postWedgeAlert ??
    ((text: string) => process.stderr.write(`[channel-wedged] ${text}\n`))
  const result = await runBoundedChannelWedgeRespawn<ReplSession>({
    attempt: async (n) => {
      try {
        return { ok: true, value: await spawnSession(sessionKey, options, spec, resume) }
      } catch (e) {
        const wedged = e instanceof ChannelWedgedSpawnError
        if (wedged && n < MAX_FLEET_RESPAWNS) {
          process.stderr.write(
            `[channel-wedged] ${sessionKey}: channel MCP never bound (/health 200 but unwired); ` +
              `bounded respawn ${n + 1}/${MAX_FLEET_RESPAWNS}\n`,
          )
        }
        return { ok: false, wedged, error: e }
      }
    },
    alert: () => alert(buildChannelWedgeCapAlertText({ sessionKey })),
  })
  if (result.kind === 'ok') return result.value
  // capped (still wedged after the cap) or a non-wedged failure → propagate the
  // underlying error so getOrSpawnSession's `spawning.catch` runs the existing
  // pool-delete + in-flight-clear cleanup.
  throw result.error
}

/**
 * Resolve whether a (re)spawn for `sessionKey` should `--resume` a captured
 * session. Reads the persisted registry and routes the record through the
 * (previously-DORMANT) `resolveRespawnStrategy` — the respawn-is-always-resume
 * core. Returns a directive only when the strategy resolves to a resumable
 * `session-id`; otherwise undefined (cold/fresh spawn). Supervision-off
 * (`replRegistryPath` unset) always returns undefined → exact S1 behavior.
 */
function resolveResumeDirective(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
): ResumeDirective | undefined {
  if (options.replRegistryPath === undefined) return undefined
  const record = getRecord(options.replRegistryPath, sessionKey)
  if (record === undefined) return undefined
  const resolutionInput: { session_id?: string; has_session: boolean } = {
    has_session: record.has_session,
  }
  if (record.has_session && record.sessionId) resolutionInput.session_id = record.sessionId
  const resolution = resolveRespawnStrategy(resolutionInput)
  if (resolution.strategy === 'session-id' && resolution.sessionId) {
    return { sessionId: resolution.sessionId }
  }
  return undefined
}

export async function getOrSpawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  forceResume?: ResumeDirective,
): Promise<ReplSession> {
  const requestedToolSurface = spec.tools.map((t) => t.name).join(',')
  // P0-1 defense-in-depth (Codex r1 [P2]): the native-MCP tool bridge is a
  // SPAWN-time property of the REPL, exactly like the tool surface. Compute what
  // THIS request would attach so the reuse guard can refuse to serve a
  // bridge-mismatched warm child — making the bridge restriction LOCAL, not
  // dependent on `substrate_instance_id` keying (today they align, so this never
  // fires; it survives a future edit that varies the bridge at a finer grain).
  const requestedToolBridge =
    options.enableToolBridge === true && replToolBridgeRef.current !== undefined
  // A resume-session-picker recovery (row #7) poisons the warm session AND records
  // the disk-recovered session id on it; captured below (for BOTH the alive-evict
  // and already-exited paths) so the clean respawn resumes THAT transcript (Codex
  // P1/P2) rather than the stale-id registry that would re-trip the picker.
  let evictedResume: ResumeDirective | undefined
  // Set when the evicted session's resume-picker recovery found NOTHING to recover:
  // the next spawn must be FRESH (resume forced off) so it rewrites the stale-id
  // registry `has_session: false` instead of re-`--resume`ing the stale id into the
  // picker (Codex P2). Captured alongside `evictedResume` below.
  let evictedForceFresh = false
  const existing = pool.get(sessionKey)
  if (existing !== undefined) {
    const session = await existing
    // Capture the resume-picker recovery's directives BEFORE the alive/exited branch
    // split (Codex P2): a poisoned session whose escaped child has ALREADY exited
    // before the next dispatch still falls through to the spawn below, and without
    // this it would fall back to `resolveResumeDirective` → the stale-id registry →
    // reopen the picker. Applies whether the child is alive or dead.
    if (session.pendingResumeSessionId !== undefined) {
      evictedResume = { sessionId: session.pendingResumeSessionId }
    }
    if (session.forceFreshRespawn) {
      evictedForceFresh = true
    }
    if (!session.hasChildExited()) {
      // Two reuse guards gate serving a turn on the warm child; BOTH must pass or
      // the child is evicted + respawned (resuming the captured session when
      // supervised, so conversational context survives the respawn):
      //
      //   1. SECURITY-CRITICAL (Codex-r1-P1) tool-surface guard: a warm REPL is
      //      locked to the tool surface it was SPAWNED with. A turn requesting a
      //      DIFFERENT surface must not reuse it, so a less-privileged turn (e.g. an
      //      import `tools:[]`) can never inherit a more-privileged warm session's
      //      tools. In practice the trust boundary aligns with `substrate_instance_id`
      //      (in the key), so this rarely fires; it's defense-in-depth that makes the
      //      tool restriction local, not dependent on keying.
      //
      //   2. CREDENTIAL-FRESHNESS guard (Codex-r2-P1): the pool key folds the STABLE
      //      `PooledCredential.id`, NOT the rotating OAuth token VALUE. The composer
      //      refreshes `CLAUDE_CODE_OAUTH_TOKEN` per dispatch, but warm reuse can't
      //      re-apply env to a running child — so after the access token rotates, a
      //      warm REPL would keep serving turns on the EXPIRED token until it died,
      //      breaking Max-OAuth instances exactly when S3 makes the persistent REPL the
      //      sole default. Re-checking the live token fingerprint on EVERY dispatch
      //      means a rotated token evicts + respawns BEFORE the next turn runs, while
      //      an UNCHANGED token (the refresh returned the still-valid cached value)
      //      reuses the warm child, so we don't churn the REPL on every dispatch.
      //      This is the PRIMARY (in prod, SOLE) stale-token defense — the
      //      `claudeConfigDir` self-refresh model below is dormant plumbing with no
      //      live caller, so when it IS threaded both fingerprints are empty and
      //      this guard simply never fires (it does not REPLACE the guard).
      //
      //      Argus r3 IMPORTANT (2026-06-08) — residual window, accurately scoped:
      //      this check runs in `getOrSpawnSession`, BEFORE the caller's
      //      `acquireTurn()` mutex wait + inject. The COMMON case (token already
      //      rotated at dispatch time) is eliminated here. But a token that EXPIRES
      //      during this turn's own mutex-wait/inject — or, fundamentally, at any
      //      instant after the check, since warm reuse can't re-apply env to the
      //      running child — can still be served ONCE on the stale token. No
      //      synchronous re-check (even one re-run after `acquireTurn`) fully closes
      //      that: expiry-in-flight is inherent to a long-lived child holding a
      //      time-bounded token. The real, complete defense is the failure path: the
      //      stale turn surfaces as at most a SINGLE retryable 401, and the
      //      immediately-following dispatch refreshes the env token → this same
      //      freshness guard then evicts + respawns (resuming the captured session,
      //      so conversational context survives). Self-healing within one turn; NOT
      //      a "there is no window" guarantee.
      const freshSurface = session.toolSurface === requestedToolSurface
      // P0-1 defense-in-depth: never serve a bridge-mismatched warm child.
      const freshBridge = session.toolBridgeActive === requestedToolBridge
      const freshCredential = session.authFingerprint === authFingerprintFor(options.env)
      // ABANDON-POISON guard (2026-06-18 warm-session hang fix): a session whose
      // prior turn was abandoned (caller timeout / substrate turn-timeout) is left
      // with a RUNAWAY turn still executing on the warm child + a desynced
      // dev-channel correlation. Reusing it lands the next turn's inject on a busy
      // REPL whose stale-reply debt strips the next reply's turn_id → the turn
      // never delivers (the cascade). Evict + respawn a clean REPL instead, exactly
      // like the freshness guards below. NOT silent — log so the eviction is
      // observable in prod.
      if (freshSurface && freshBridge && freshCredential && !session.poisoned) return session
      if (session.poisoned) {
        process.stderr.write(
          `[repl] evicting abandon-poisoned warm session=${session.sessionId.slice(0, 8)} key-respawn (prior turn abandoned before reply; clean respawn for the next turn)\n`,
        )
      }
      // Evict, then AWAIT the old child's exit before falling through to spawn so a
      // supervised `--resume` replacement (same sessionId) never co-owns the session
      // transcript with the dying child (the Argus-r3 one-owner invariant). The
      // credential-freshness path fires on every token rotation (regularly), unlike
      // the rarely-firing tool-surface mismatch, so honoring the await here matters.
      pool.delete(sessionKey)
      if (childByKey.get(sessionKey) === session.child) childByKey.delete(sessionKey)
      await terminateChild(session.child)
    } else {
      pool.delete(sessionKey)
    }
  }
  // Precedence: an explicit caller `forceResume` (admin/watchdog) wins; else a
  // resume-picker MISS forces a fresh spawn (`evictedForceFresh`, breaking the
  // stale-resume loop); else a resume-picker HIT resumes the recovered transcript
  // (`evictedResume`); else the normal registry-resolved directive.
  const resume = forceResume
    ?? (evictedForceFresh ? undefined : (evictedResume ?? resolveResumeDirective(sessionKey, options)))
  const spawning = spawnWithChannelWedgeRespawn(sessionKey, options, spec, resume)
  pool.set(sessionKey, spawning)
  spawning.catch(() => {
    pool.delete(sessionKey)
    // An async spawn failure (assertion / health) on a RESUME must clear the
    // in-flight stamp so the watchdog retries on the next tick instead of seeing
    // a latched "respawn in progress" that never completes (Codex P2-4).
    if (resume !== undefined && options.replRegistryPath !== undefined) {
      clearRespawnInFlight(options.replRegistryPath, sessionKey)
    }
  })
  return spawning
}

/** Resolve once the REPL's PTY has been quiet for `quietMs` (claude is idle and
 *  ready for the next channel turn), or after `maxMs` as a defensive cap. */
export async function waitForReplIdle(session: ReplSession, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (Date.now() - session.lastDataAt >= quietMs) return
    await Bun.sleep(100)
  }
}

export async function injectMessage(channelPort: number, text: string, turnId: string): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${channelPort}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': sink.token },
    // `turn_id` round-trips through the dev-channel onto the matching reply so
    // `onReply` can correlate the completion to this exact turn (Argus r5 fix).
    body: JSON.stringify({ text, turn_id: turnId }),
  })
  if (!resp.ok) {
    throw new Error(`persistent-repl: inject failed (${resp.status})`)
  }
}
export function gateFor(sessionKey: string): InFlightGate {
  let g = respawnGates.get(sessionKey)
  if (g === undefined) {
    g = makeInFlightGate()
    respawnGates.set(sessionKey, g)
  }
  return g
}

/** Clear a latched `respawn_in_flight_at` stamp (lock-guarded). Used when a
 *  respawn refuses/fails so the next tick can retry without waiting out the TTL. */
export function clearRespawnInFlight(registryPath: string, sessionKey: string): void {
  try {
    withRegistry(registryPath, (registry) => {
      const r = registry[sessionKey]
      if (r) {
        const { respawn_in_flight_at: _drop, ...rest } = r
        registry[sessionKey] = rest
      }
      return { registry, result: undefined }
    })
  } catch {
    /* best-effort */
  }
}
