import { observeSession } from './observe-workers.ts'
import { describeWorkerObservation } from './worker-observation.ts'
// persistent-repl-substrate.ts → spawn.ts
// Session spawn / resume / turn-inject machinery + the respawn in-flight gate
// (D2 split).

import { requireReplCwd } from './spawn-configuration-error.ts'
import { dropLocalOwnership } from './local-ownership.ts'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpSurfaceFingerprint } from '../../../mcp-servers.ts'
import type { AgentSpec } from '../../../substrate.ts'
import { type DeadTurnNotice, startApi5xxDeadTurnWatcher } from './api5xx-dead-turn-watcher.ts'
import { buildReplArgv, resolveReplEffort } from './build-repl-argv.ts'
import { supportsAutocompact } from './autocompact-support.ts'
import { buildSettings } from './build-settings.ts'
import { configuredPtyHost } from './configured-pty-host.ts'
import { ChannelWedgedSpawnError, MAX_FLEET_RESPAWNS, buildChannelWedgeCapAlertText, runBoundedChannelWedgeRespawn } from './channel-unbound-respawn.ts'
import { ensureClaudeTrust } from './ensure-claude-trust.ts'
import type { SubstrateClassed } from './classify-spawn-error.ts'
import { paneClaimBlocksUs, spawnReservationBlocksUs } from './signatures.ts'
import { applyModelFloor } from './model-floor.ts'
import { type InFlightGate, makeInFlightGate } from './in-flight-gate.ts'
import { childByKey, pendingSpawns, pool, replToolBridgeRef, respawnGates, sink } from './pool-state.ts'
import {
  registerLiveProcessSafe,
  type LiveProcessHandle,
} from '@neutronai/tools/process-registry.ts'
import { assertReplAlive } from './post-spawn-assertion.ts'
import type { PtyChild } from './pty-host.ts'
import { RATE_LIMIT_BANNER_SEVERITIES, createRateLimitBannerDetector } from './rate-limit-banner.ts'
import { createAuthFailureDetector } from './auth-failure-signature.ts'
import {
  type ReplRegistryRecord,
  disownPane,
  getRecord,
  normaliseRecord,
  readRegistryState,
  registryConversationScopeMatches,
  ownPane,
  patchRecord,
  releasePaneSpawnReservation,
  reservePaneSpawn,
  withOwnedRegistry,
  withRegistry,
} from './repl-registry.ts'
import {
  readChildPid,
  recordGatewayShutdownKill,
  sampleLivenessBeforeShutdownKill,
  type PendingShutdownKillReport,
  type ShutdownExitWatch,
} from './gateway-shutdown-kill.ts'
import { resolveRespawnStrategy } from './respawn-strategy.ts'
import { createResumePickerDetector } from './resume-picker-detector.ts'
import { captureSession, makeJsonlExistsProbe } from './session-capture.ts'
import { measurePostCompactSize, sessionJsonlPath, startSessionSizeWatchdog } from './session-size-watchdog.ts'
import { dashifyCwd } from './session-validation.ts'
import { createWedgedPromptDetector } from './interactive-prompt-deadlock-detector.ts'
import { DEFAULT_AGENT_BASE_PROMPT, DEFAULT_DEV_CHANNEL_PATH, DEFAULT_TOOLS_BRIDGE_PATH, SESSION_COMPACT_IDLE_QUIESCE_MS, TOOLS_BRIDGE_SERVER_NAME, mcpStartupTimeoutMs, resolveTranscriptProjectsDir, runOutputScan, sendKey, surfaceSizeAlert } from './signatures.ts'
import type { PersistentReplSubstrateOptions, ResumeDirective } from './types.ts'
import { ReplSession, authFingerprintFor, httpHealth, mergeEnv, terminateChild, unlinkSessionConfigs } from './repl-session.ts'
import { wireChildExit } from './child-exit-wiring.ts'
import { replSessionConfigPaths } from './session-config-paths.ts'
import { registerReplDetectors } from './repl-detectors.ts'
import { adoptionPermitsSpawn, armSelfFence, beginBootAdoption } from './boot-adoption.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

async function spawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  resume?: ResumeDirective,
): Promise<ReplSession> {
  const cwd = requireReplCwd(options.cwd)
  // ISSUES #537 — start the sink on its DERIVED-PER-INSTANCE port with its
  // PERSISTED token, both keyed off this substrate's state dir (`sinkTokenPath`,
  // derived with the rest of the durable REPL state by
  // `deriveReplSupervisionPaths`; `sinkPort` overrides the derivation). Both coordinates are baked into the child below
  // and in `buildSettings`, and the child can never be re-pointed — so they have
  // to be values the NEXT gateway process reproduces. Idempotent: only the first
  // call in this process binds.
  await sink.ensureStarted({
    ...(options.sinkPort !== undefined ? { port: options.sinkPort } : {}),
    ...(options.sinkTokenPath !== undefined ? { tokenPath: options.sinkTokenPath } : {}),
  })
  const requestedModel = spec.model_preference[0]
  if (requestedModel === undefined) {
    throw new Error('persistent-repl: model_preference is empty; at least one model required')
  }
  // The default frontier floor excludes the exact native model explicitly selected
  // by this conversation's owner. A marker from a different conversation grants nothing.
  // FRONTIER-MODEL FLOOR (`model-floor.ts`). THE reason this lives here and not
  // at the two `record.model ?? getBestModel()` call sites: this line is the ONE
  // place a model id becomes a spawned child, and the same `model` binding feeds
  // BOTH the argv (`--model`, below) and the registry row written after the child
  // is ready. Clamping once therefore (a) keeps an owner chat off a lower tier
  // whatever wrote the record, and (b) un-poisons the row in the same breath, so
  // the value cannot self-perpetuate into the next respawn. A substrate without
  // the floor is returned verbatim — the deliberate FAST_MODEL utility callers
  // are untouched. The module header records the writer that was found (#340)
  // and the two reasons the floor is still load-bearing without it.
  const previousModel = options.replRegistryPath === undefined ? undefined
    : getRecord(options.replRegistryPath, sessionKey)
  if (previousModel !== undefined && !registryConversationScopeMatches(previousModel, options)) {
    throw new Error('persistent-repl: conversation scope is ambiguous or mismatched; refusing spawn/resume')
  }
  const selected = resume !== undefined && previousModel?.sessionId === resume.sessionId &&
    typeof previousModel.owner_selected_model === 'string' && previousModel.owner_selected_model.trim() !== ''
    ? previousModel.owner_selected_model : undefined
  const model = applyModelFloor({
    requested: selected ?? requestedModel,
    enabled: options.frontierModelFloor === true && selected === undefined,
    sessionKey,
    source: resume !== undefined ? 'resume' : 'spawn',
    // The half of "make it loud" that leaves the box. Without this the clamp is
    // a stderr line on a box nobody reads — the same invisibility that let the
    // degradation run for a day. Both FLOORED substrates supply it
    // (`open/wiring/substrates.ts`), and they supply DIFFERENT sinks: the owner's
    // chat lane bubbles + journals, the timer-driven nudge lane journals only, so
    // a background clamp is recorded without interrupting him. A substrate that
    // omits it keeps the stderr fallback.
    ...(options.onModelFloorApplied !== undefined
      ? { notify: options.onModelFloorApplied }
      : {}),
  })
  // Resolve ONCE, here: like `model` above, this single binding feeds the argv
  // now and the launch record/registry stamp (T2), so the reported value cannot
  // diverge from the spawned one.
  const effort = resolveReplEffort(options.effort)
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
  const ptyHost = options.ptyHost ?? configuredPtyHost
  const devChannelPath = options.devChannelPath ?? DEFAULT_DEV_CHANNEL_PATH
  const toolsBridgePath = options.toolsBridgePath ?? DEFAULT_TOOLS_BRIDGE_PATH
  const appendSystemPromptFile = options.appendSystemPromptFile ?? DEFAULT_AGENT_BASE_PROMPT

  // CONSTRUCT THE SESSION FIRST, because the child's own CREDENTIAL derives from it
  // and has to be written into the config files below. It is registered further down,
  // still BEFORE the spawn, so a fast `/channel-ready` POST can never race ahead of
  // the sink registration (the original reason this block sat before the spawn).
  const childGeneration = randomUUID()
  const session = new ReplSession(sessionKey, childGeneration, sessionId, channelName, cwd)
  // THE CREDENTIAL THIS CHILD WILL PRESENT — `HMAC(root token, childGeneration)`,
  // derived by the sink so the value baked here and the value the sink authorizes
  // cannot drift. It replaces the shared root token in every place the child is handed
  // a secret: a child never sees the root, so it cannot compute a sibling's
  // credential, and its own dies with this incarnation. See
  // `sink-coordinates.ts`'s `deriveChildSinkToken` for why a session id could not do
  // this job — it is an identifier, published to the process table by `--resume`.
  const childToken = sink.credentialFor(session)

  // Per-session config files (mcp-config wires the dev-channel; settings wires
  // the enforce-reply Stop hook).
  //
  // OWNER-ONLY DIRECTORY (adversarial security review 2026-07-20). These were
  // previously written directly into a shared `tmpdir()` — the mcp-config at the
  // process umask (no mode argument at all) — and it carries the MCP sink TOKEN
  // in plaintext. Any same-uid process could read it and then dispatch tools
  // against the bridge. A 0700 per-spawn directory plus 0600 files keeps the
  // token owner-readable. The wider bridge-auth fix that sentence used to defer —
  // a per-session token plus a check before dispatch — SHIPPED with ISSUES #537:
  // each child is handed `HMAC(root token, childGeneration)` in this very directory
  // and the sink authorizes credential -> session (`pool-state.ts`, `ReplSink.handle`).
  // So what these modes protect is no longer a fleet-wide secret but this child's own
  // credential, which is a smaller blast radius and the same discipline.
  //
  // RE-EXAMINED UNDER A PERSISTED TOKEN (ISSUES #537). The token these files carry
  // is no longer minted per gateway process — it is loaded from a 0600 file in the
  // instance state dir, so it is the same secret across restarts. The reasoning
  // above therefore gets STRONGER, not weaker: these modes are what keep a
  // now-long-lived secret owner-only, and nothing here is relaxed. What did change
  // is the exposure WINDOW — from one process lifetime to indefinitely — a
  // deliberate trade for letting a REPL outlive its gateway, spelled out in
  // `sink-coordinates.ts`'s header where the token is loaded.
  const { dir: cfgDir, mcpConfigPath, settingsPath, toolsManifestPath } =
    replSessionConfigPaths(channelName)
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 })

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
        SINK_TOKEN: childToken,
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
          SINK_TOKEN: childToken,
          SESSION_ID: sessionId,
          TOOLS_MANIFEST_PATH: toolsManifestPath,
          BRIDGE_SERVER_NAME: TOOLS_BRIDGE_SERVER_NAME,
        },
      }
      toolBridgeActive = true
    }
  }

  // OWNER-INSTALLED MCP SERVERS — every approved server the owner added in Settings,
  // merged in ALONGSIDE the two compiled-in entries above. Before this, the agent's
  // session got exactly those two and nothing could add a third, so the whole MCP
  // ecosystem was unreachable from the owner's own assistant (a cutover-parity gap).
  //
  // GATED TWICE, and both gates are load-bearing. `resolveExtraMcpServers` is wired
  // ONLY onto the owner's warm conversational substrate, and `enableToolBridge` is
  // required here as well — the same trust class the in-process tool bridge rides.
  // The untrusted history-import (`cc-import-*`) and disposable Trident
  // (`cc-trident-*`) REPLs run `tools: []` default-deny precisely to close a
  // prompt-injection vector, and an owner-installed subprocess is a strictly larger
  // capability than a built-in tool. Two independent conditions mean a future wiring
  // mistake on either one alone cannot open that vector.
  //
  // Gated on the OPT-IN (`options.enableToolBridge`) rather than on `toolBridgeActive`
  // (whether a bridge was actually attached): an empty tool registry must not silently
  // switch off the owner's MCP servers, which are unrelated to it.
  const extraMcpServers =
    options.enableToolBridge === true && options.resolveExtraMcpServers !== undefined
      ? await options.resolveExtraMcpServers()
      : []
  const wiredExtraNames: string[] = []
  for (const server of extraMcpServers) {
    // Defence in depth behind the name validator, which already reserves `neutron`
    // and the `neutron-` prefix: never let an installed server take a key the
    // built-ins hold. A collision would either shadow the agent's only way to reply
    // or be dropped, decided by merge order — the worst kind of coin flip.
    if (Object.prototype.hasOwnProperty.call(mcpServers, server.name)) {
      process.stderr.write(
        `[repl] skipping owner MCP server '${server.name}': name collides with a built-in server\n`,
      )
      continue
    }
    mcpServers[server.name] = {
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    }
    wiredExtraNames.push(server.name)
  }

  // The config carries the dev-channel token AND (now) every installed server's
  // secrets, so the 0600 mode on this write and the 0700 mode on `cfgDir` above are
  // what keeps them owner-readable. Nothing logs the file's contents.
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 })
  // Task 6 (T5 write-containment) — forward the optional `permissions` block onto
  // the per-session settings write so a ritual write-containment REPL's deny rules
  // land in `--settings`. Absent ⇒ the Stop-hook-only write, unchanged.
  buildSettings({
    settingsPath,
    // WAVE 3.5 task B — wire the TodoWrite→Work Board PostToolUse hook on the REPLs
    // that opt into the Neutron tool bridge. The disposable Trident build REPLs + the
    // untrusted history-import REPL never enable the bridge, so their TodoWrite stays
    // build-internal and never lands on the owner's board. The sink is already
    // started (above), so its port/token are bound here.
    // ACTIVITY INSPECTOR — the tool tap rides the same gate for the same reason,
    // never on the disposable Trident build REPLs or the untrusted history-import
    // REPL, so a build's internal tool churn never lands on the owner's project panel.
    //
    // NB "the bridge REPLs" is no longer a synonym for "the owner's chat REPL": the
    // background proactive-compose lane (`cc-nudge-*`, `open/wiring/substrates.ts`)
    // also enables the bridge, deliberately, so a ritual can reach the same tools the
    // owner's chat can. So these two hooks ride onto that lane as well. That is
    // intended — both are OWNER-FACING REPORTING of work done for the owner, not a
    // chat interruption — and it is why this gate is described by what it grants
    // rather than by which single session used to carry it.
    ...(options.enableToolBridge === true
      ? {
          todoSync: { sinkPort: sink.port, sinkToken: childToken, sessionId },
          activityTap: { sinkPort: sink.port, sinkToken: childToken, sessionId },
          pipelineGuard: {},
        }
      : {}),
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
  const claudeBin = options.claude_bin ?? process.env['CLAUDE_BIN'] ?? 'claude'
  const argv = buildReplArgv({
    claudeBin,
    sessionId,
    resume: resume !== undefined,
    channelName,
    mcpConfigPath,
    settingsPath,
    appendSystemPromptFile,
    model,
    effort,
    // The cwd FIRST, then whatever else this spawn declared. Under `--restricted`
    // this list is the agent's entire readable filesystem.
    addDirs: [cwd, ...(options.extra_dirs ?? [])],
    tools: toolSurface,
    // Token budget upstream; omit it for older CLIs that reject the option.
    ...(supportsAutocompact(claudeBin) ? { autocompactTokens: 300000 } : {}),
    // P0-1 — when the tool bridge is attached, permit its MCP namespace so the
    // agent can invoke the Neutron tools without a per-call approval prompt.
    // `--tools` only gates the BUILT-IN set, so the security-critical
    // `--tools ""` for untrusted-content REPLs is untouched; this allow-list is
    // the MCP-tool permission grant (`mcp__neutron`), added ONLY here.
    //
    // Each owner-installed server needs its OWN `mcp__<name>` entry: being present
    // in `mcpServers` only makes a server START, and its tools would then hit a
    // per-call permission prompt no headless REPL can answer. Wiring the config and
    // granting the namespace are two separate links, and a server is only usable
    // when BOTH hold — which is why the tests assert them separately.
    ...(toolBridgeActive || wiredExtraNames.length > 0
      ? {
          allowedMcpTools: [
            ...(toolBridgeActive ? [`mcp__${TOOLS_BRIDGE_SERVER_NAME}`] : []),
            ...wiredExtraNames.map((n) => `mcp__${n}`),
          ],
        }
      : {}),
    ...(options.skip_permissions !== undefined ? { skipPermissions: options.skip_permissions } : {}),
    ...(options.restricted !== undefined ? { restricted: options.restricted } : {}),
    ...(options.permission_mode !== undefined
      ? { permissionMode: options.permission_mode }
      : {}),
  })

  session.toolSurface = toolSurface.join(',')
  // Stamp the active project scope this REPL serves (folded into the pool key, so
  // it is stable for the session's whole lifetime). The `/tool-call` sink reads
  // it to bind the active project into a tool dispatch — see `ReplSession.projectId`.
  session.projectId = options.project_id
  // P0-1 — stamp the bridge attachment so the reuse guard can refuse a
  // bridge-mismatched turn (matches the `requestedToolBridge` computation).
  session.toolBridgeActive = toolBridgeActive
  // Stamp the installed-MCP-server surface this child was SPAWNED with. `mcpServers`
  // is read once by `claude` at startup, so a warm child physically cannot learn
  // about a server installed afterwards — the reuse guard below evicts + respawns
  // (resuming the transcript) when the fingerprint moves, which is what makes an
  // install take effect on the next turn. Equal config yields an equal fingerprint,
  // so an unchanged set reuses the warm child rather than paying a cold spawn per
  // message. The digest is in-memory only; it is derived from secret values and is
  // never logged or persisted.
  session.mcpFingerprint = mcpSurfaceFingerprint(extraMcpServers)
  // Stash the temp config paths so teardown can unlink them (Argus r5 IMPORTANT —
  // ephemeral one-shots write a fresh pair per call; leaked otherwise). The tools
  // manifest is only written when the bridge is active; include it when so.
  session.configPaths = toolBridgeActive
    ? [mcpConfigPath, settingsPath, toolsManifestPath]
    : [mcpConfigPath, settingsPath]
  // Stamp the auth fingerprint the child is being spawned with so the warm-reuse
  // freshness guard can evict on a same-credential-id token refresh (Codex r2 P1).
  session.authFingerprint = authFingerprintFor(options.env, options.sinkTokenPath)
  // #1237 — the admission generation this parent is spawned under, read ONCE and
  // BEFORE the child is launched, so the stamp can only describe the scope as it
  // stood when this child began. Persisted below in the same write as `reuse`.
  session.admissionGeneration = await readAdmissionGeneration(options, sessionKey)

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
  // …AND BOUND HOW LONG THAT BLOCKING LOAD MAY WAIT, once the config holds a server
  // Neutron did not write.
  //
  // The blocking load above was safe when `--mcp-config` contained only our own two
  // entries: both are `bun` scripts in this repo that hand-shake in milliseconds, so
  // "wait for the handshake" could not wait long. An owner-installed server is a
  // third-party program, and a program that accepts a connection and then never
  // completes `initialize` would hold the blocking load open — inside the 30 s
  // `readyBudgetMs` of the post-spawn assertion, on the owner's PRIMARY conversational
  // REPL. The failure would present as `channel-wedged` and take the bounded-respawn
  // ladder with it, all because of one badly-behaved MCP server.
  //
  // `MCP_TIMEOUT` is `claude`'s own MCP-startup timeout (verified present in the CLI's
  // env-var table in 2.1.223, alongside `MCP_CONNECTION_NONBLOCKING` itself). Bounding
  // it well under the assertion's ready budget means a hung server costs one slow
  // spawn and is reported by `claude` as a server that failed to start, instead of
  // taking the session down. Set ONLY when an installed server is actually wired, so
  // the no-MCP-servers spawn keeps exactly the startup behaviour it has today.
  //
  // The bound is PER SERVER while the ready budget covers the whole spawn, so it is
  // divided across the servers actually wired rather than being a flat 10 s that N
  // hung servers could each honour while collectively blowing the budget.
  //
  // DIVIDED BY EVERY ENTRY IN THE CONFIG, NOT BY THE OWNER'S COUNT. `MCP_TIMEOUT` is
  // process-wide: `claude` applies it to each server in `--mcp-config`, and this config
  // always also holds the dev-channel reply sink and (when attached) the tools bridge.
  // Passing `wiredExtraNames.length` here therefore understated the serial worst case by
  // the built-ins on every spawn — two owner servers got 20 s / 2 = 10 s each across FOUR
  // configured servers, 40 s against the assertion's 30 s ready budget.
  //
  // `Object.keys(mcpServers).length` is the exact count that is about to be serialised
  // one screen above, so this cannot drift if a third built-in is ever added — unlike
  // `wiredExtraNames.length + 2`, which would be a copy of a fact this object already
  // holds. See `mcpStartupTimeoutMs` for what the floor does not fix.
  if (wiredExtraNames.length > 0) {
    childEnv['MCP_TIMEOUT'] = String(mcpStartupTimeoutMs(Object.keys(mcpServers).length))
  }
  if (options.skipTrustSeed !== true) {
    const trustInput: Parameters<typeof ensureClaudeTrust>[0] = { cwd }
    if (options.claudeConfigDir !== undefined) trustInput.configDir = options.claudeConfigDir
    ensureClaudeTrust(trustInput)
  }
  if (options.claudeConfigDir !== undefined) {
    childEnv['CLAUDE_CONFIG_DIR'] = options.claudeConfigDir
  }

  // Every output-scan detector this session carries — one set, one owner
  // (`repl-detectors.ts`), shared with the boot-adoption path so a re-adopted REPL
  // is watched by exactly the same detectors as a freshly spawned one.
  registerReplDetectors(session, options)

  // The spawn `const child` isn't assigned when the `onScreen` closure is defined,
  // so route fired-detector keystrokes through this mirror (set right after
  // spawn, before any onScreen can fire on the event loop).
  let scanChild: PtyChild | undefined
  // F4 — the ambient live-process handle for THIS child, assigned right after the
  // register call below (before any onScreen can fire on the event loop). It is
  // bound to the owning registry + this child's (name, pid), so a late touch from
  // this child can never refresh a different registry or a respawned successor.
  let liveHandle: LiveProcessHandle | undefined

  // ─── THE SPAWN RESERVATION (#539 r47) ──────────────────────────────────────────────────
  //
  // TAKEN BEFORE `PtyHost.spawn`, because that call is the moment this gateway becomes
  // CAPABLE of touching the transcript: a `claude --resume <id>` appends through startup and
  // readiness, and two of them resuming into one file is the corruption this module exists to
  // prevent — not a duplicated wrapper, which is merely how it shows up. Contending AFTER the
  // spawn (which is what r45 built, and all it could build with a pane claim) still lets the
  // loser's process write. So the loser never spawns.
  //
  // See the ordering invariant at the top of `boot-adoption.ts`; this is its second citation.
  const spawnReserver = randomUUID()
  const reservationPid = options.claimantPid ?? process.pid
  const reservation = reserveSpawnForKey(options, sessionKey, spawnReserver, Date.now(), reservationPid, {
    sessionId,
    cwd,
    channelName,
    hasSession: resume !== undefined,
  })
  if (reservation === 'taken' || reservation === 'unwritable') {
    // NOTHING WAS STARTED AND NOTHING WAS REGISTERED (r63). The sink registration used to be
    // taken one line ABOVE this decision, which made a losing contender capable of revoking
    // the winner's credential before it ever learned it had lost — so the unwind that stood
    // here is gone with the registration that needed it. The refusal carries
    // `repl_unreconciled` like every other "this turn cannot be served here".
    throw new PaneOwnershipRefusedError(
      `persistent-repl: refusing to serve session ${sessionKey.slice(0, 32)} — ` +
        (reservation === 'taken'
          ? 'another gateway has RESERVED this session key and is starting a REPL for it, so spawning now would ' +
            'put two `claude --resume` processes on one transcript. Nothing was started'
          : 'the registry lock was not acquired, so this spawn could not be RESERVED and a second gateway could ' +
            'be starting one for the same transcript. Nothing was started') +
        ' and this turn fails instead; it retries on the next turn.',
    )
  }
  // `Awaited<...>`: `PtyHost.spawn` is ASYNC under herdr — it connects, applies the
  // layout and learns the pane's pid before it can hand back a child, and `child.pid`
  // is read synchronously just below.
  // RELEASED ON EVERY PATH OUT, which is why it is a `finally` rather than a release at the
  // sites that happen to be on the success route. A reservation left behind blocks its own
  // key until the TTL — a bounded cost, but a self-inflicted one, and this function has many
  // ways to fail between the spawn and the ownership write (a readiness handshake, a config
  // write, a watcher). Once the row records ownership the claim protects the key, so the
  // reservation has done its whole job by the time this returns either way.
  // REGISTERED BEHIND THE RESERVATION, AND IMMEDIATELY BEFORE THE SPAWN (r47 ordering,
  // corrected r63).
  //
  // Sink registration is a CAPABILITY — it is what makes a reply from this child acceptable —
  // and round forty-seven's rule is that no capability is enabled before ownership is
  // established. It is also the one capability whose acquisition REVOKES another session's, so
  // taking it before the reservation let a turn that went on to lose strip the winner.
  //
  // It cannot move later either: the child can POST the moment it starts, and an unregistered
  // credential is a 401 on a reply we asked for. So it sits in the smallest window that
  // satisfies both — after the reservation is won, before `PtyHost.spawn` — and a registration
  // the sink refuses fails this turn rather than serving a child nothing can authorize.
  sink.register(sessionId, session)
  try {
    let child: Awaited<ReturnType<typeof ptyHost.spawn>>
    try {
      child = await ptyHost.spawn(argv, {
      cwd,
      env: childEnv,
      ...(options.repl_pane_label !== undefined ? { label: options.repl_pane_label } : {}),
      ...(options.projectPlacement !== undefined ? { projectPlacement: options.projectPlacement } : {}),
      // SNAPSHOT-REPLACE, not append — on either backend. Each delivery is the child's
      // whole current screen (see `pty-host.ts` / `pty-ring.ts`), and `replace` is what
      // keeps the detector falling edge working: a cleared screen arrives with nothing
      // on it. Where the screen comes from differs (herdr polls a rendered pane; the
      // in-process host accumulates the byte stream), and `pty-host.ts` records the one
      // consequence — a repaint collapses under herdr and does not under a pty.
      onScreen: (screen) => {
        session.ring.replace(screen)
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

    // EVERY CONSUMER THE `onScreen` CLOSURE READS IS NOW WIRED — `scanChild` (the
    // keystroke target) and `liveHandle` (the activity touch) — so screens may start
    // flowing. Until this call the host does not poll at all.
    //
    // This must be the LAST step of the wiring, and it exists because `spawn` is async:
    // the closure above is built before `child` exists, so a host that began polling
    // before returning could deliver the FIRST screen while `scanChild` was still
    // undefined. That screen was dropped unscanned — and because the ring is
    // snapshot-replace, which suppresses an unchanged screen, it was never delivered
    // again: a startup trust prompt or approval dialog left undismissed for the life of
    // a REPL that stayed alive and polling. `PtyChild.beginOutput` carries the full
    // reasoning; the general form is that an `await` between a producer and its consumer
    // opens a window for everything the producer already started.
    child.beginOutput?.()

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
    wireChildExit({
      session,
      child,
      sessionKey,
      sessionId,
      // BY GETTER, NOT BY VALUE. It happens to be assigned already on this path; it is
      // NOT on every path (the handle needs a pid, so a caller that wires the exit
      // before registering the pid holds `undefined` here), and a by-value capture
      // would silently skip the crash reconciliation there. See `ChildExitWiring`.
      liveHandle: () => liveHandle,
      label: 'spawn.then',
      registryPath: options.replRegistryPath,
    })
    } catch (e) {
      // The spawn never produced a child, so the registration it was made for must not
      // outlive it. `unregisterIf` rather than `unregister`: a concurrent respawn may
      // already hold this session id, and evicting ITS credential would turn our failure
      // into a second one. The configs go too — they carry the credential in plaintext.
      sink.unregisterIf(sessionId, session)
      unlinkSessionConfigs(session)
      throw e
    }

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
      // Capture before termination while the host can still read the prompt.
      const observation = await observeSession(session)
      assertion.detail = `${assertion.detail ?? ''}; ${describeWorkerObservation(observation)}`
      if (observation.state === 'blocked') {
        if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
        sink.unregisterIf(sessionId, session)
        await terminateChild(child)
        const error = new Error(`worker blocked: ${assertion.detail}`)
        Object.assign(error, { substrateErrorClass: 'channel_wedged' })
        throw error
      }
      if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
      sink.unregisterIf(sessionId, session)
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
      // NO POOL DELETE HERE (Argus r56). `spawnSession` cannot name the entry it owns — the
      // promise it is running inside is created by its caller — so a bare delete here removes
      // whatever happens to be registered, and the readiness assertion above is an `await`:
      // publish A, readiness waits, publish B, A fails, and this line evicted **B**. The
      // rejection this throw produces reaches `spawning.catch`, which DOES hold the promise
      // and deletes only its own entry. One site, one owner — rather than an unguarded delete
      // racing a guarded one and winning because it runs first.
      throw new Error(`persistent-repl: spawn failed (${assertion.reason}; ${assertion.detail ?? ''})`)
    }

    // the legacy harness port row #13: start the warm-session size watchdog now the REPL is
    // verified alive. It measures the POST-COMPACT JSONL size (bytes after the last
    // `"isCompactSummary":true` marker — NEVER raw `stat.size`, or "Compact does
    // nothing" re-fires forever) on a cadence and surfaces a Reset/Compact
    // affordance before the transcript grows large enough to block `--resume` (the
    // 2026-04-16 11.8 MB infinite-restart incident). `requestCompact()` actuates
    // `escape` + `/compact` + `enter` through the same write seam the disclaimer-dismiss
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
        ...(options.conversationProjectId === undefined ? {} : { conversationProjectId: options.conversationProjectId }),
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
        child_generation: childGeneration,
        first_ready_at: Date.now(),
      }
      if (session.channelPort !== undefined) record.devchannel_port = session.channelPort
      // #539 — the durable terminal handle, when this host issues one. Applied at the merge
      // below through {@link ownPane}, NOT set here: the handle and the claim that says who
      // is serving it are one fact, and a row that carries one without the other is the
      // round-forty defect. `ownPane` is the only thing that writes either.
      //
      // A CLAIM IDENTITY FOR A FRESH SPAWN, minted per spawn and recorded on the session,
      // exactly as the adoption path does. Ownership is not a property of how the session
      // came to exist: while only adoption claimed, a spawner served a pane it had not
      // claimed and an adopter could take it out from under a live gateway.
      const paneClaimant = randomUUID()
      /** Also this session's FIRST CONFIRMED ownership, if the write below lands — the origin
       *  the r44 self-fencing deadline is measured from, and the same instant the row's
       *  takeover threshold runs from. */
      const paneClaimedAt = Date.now()
      /** Which gateway this claim names — see `PersistentReplSubstrateOptions.claimantPid`. */
      const claimantPid = options.claimantPid ?? process.pid
      if (child.paneHandle !== undefined) session.paneClaimBy = paneClaimant
      // #539 — and WHAT THIS CHILD WAS SPAWNED AS, so a re-adopted session can answer
      // the warm-reuse guards instead of failing all three and being evicted on the
      // first turn after the restart. Read off the session, which is where the same
      // values were just stamped for the in-memory guards, so the persisted copy and
      // the live one cannot disagree.
      record.reuse = {
        tool_surface: session.toolSurface,
        tool_bridge: session.toolBridgeActive,
        auth_fingerprint: session.authFingerprint,
      }
      // #1237 — omitted, never written as null, when the reader answered nothing: the
      // row must then read as legacy-unknown, exactly like a row from before the field.
      if (session.admissionGeneration !== undefined) record.admission_generation = session.admissionGeneration
      try {
        // Merge onto any prior row BUT clear the transient `respawn_in_flight_at`
        // stamp: this spawn just COMPLETED the in-flight respawn, so a stale stamp
        // must not survive to block the next tick's recovery (Codex P2-3).
        const ownershipWrite = withOwnedRegistry(
          options.replRegistryPath,
          (registry) => {
          const prev = registry[sessionKey]
          const {
            respawn_in_flight_at: _drop,
            child_crash_notified_at: _oldCrashEdge,
            // #518 — `killed_by_gateway_shutdown` is DELIBERATELY NOT DROPPED HERE. It
            // is keyed by generation, so an entry for the child we are replacing can
            // never be read as describing this one, and it has to outlive that child:
            // a QUARANTINED generation is superseded by this very write, and its entry
            // is the only durable record that a deploy killed it.
            //
            // #539 — `pane_handle` IS dropped here, and the contrast with the field
            // above is the whole reason both comments exist. That one describes a
            // child that is GONE and must stay describable; this one describes the
            // child that is RUNNING, so a value inherited from its predecessor is a
            // claim about a pane this child does not have. It is re-stated below from
            // `record` when this spawn actually produced one.
            //
            // #1237 — `admission_generation` is dropped for the same reason: it describes
            // the admission state THIS child was spawned under, so a stamp inherited from
            // a predecessor would let an unstamped child read as participating. It is
            // re-stated below only when this spawn stamped one.
            admission_generation: _priorAdmissionGeneration,
            ...merged
          } = prev ? { ...prev, ...record } : record
          if (record.admission_generation !== undefined) (merged as ReplRegistryRecord).admission_generation = record.admission_generation
          if (selected === undefined) delete merged.owner_selected_model
          // #539 — OWNERSHIP IS NOT MERGED, IT IS RE-STATED, and the handle and its claim
          // move together. A spread carries the PRIOR row's `pane_handle` through whenever
          // this spawn produced none (the in-process host, a test double), so the row would
          // keep asserting a pane for a child that has no pane — and the next boot would go
          // looking for it. It also carried the prior child's CLAIM: a replacement spawn
          // inherited an ownership marker belonging to a child that no longer existed, and a
          // restart inside the takeover window then refused adoption on the strength of it.
          //
          // `disownPane` first, unconditionally, so nothing from the predecessor survives;
          // then `ownPane` only when THIS child actually has a pane.
          //
          // AND THE SPAWN CONTENDS FOR THE CLAIM (Argus r45), using the SAME predicate the
          // adoption compare-and-set uses. Round forty gave the fresh spawn a claim and no
          // CONTEST: this write replaced ownership unconditionally, so two gateways
          // reconciling one resumable row both spawned `--resume` panes and both published —
          // A recorded claim A, B took the lock and replaced it with claim B, and both served
          // one transcript until some later renewal happened to fence A. Participating in the
          // protocol means contending, not merely writing.
          //
          // Only when THIS child has a pane: a handle-less spawn owns nothing, so there is
          // nothing to contend for and the disown below still clears the predecessor's.
          if (
            child.paneHandle !== undefined &&
            prev !== undefined &&
            paneClaimBlocksUs(prev, {
              ours: paneClaimant,
              now: paneClaimedAt,
              ourPid: claimantPid,
              ...(options.claimantLiveness !== undefined
                ? { liveness: options.claimantLiveness }
                : {}),
            })
          ) {
            return { registry, result: 'lost' as const, skipSave: true as const }
          }
          const disowned = disownPane(merged as ReplRegistryRecord)
          registry[sessionKey] =
            child.paneHandle !== undefined
              ? ownPane(disowned, {
                  handle: child.paneHandle,
                  generation: childGeneration,
                  claimant: paneClaimant,
                  now: paneClaimedAt,
                  pid: claimantPid,
                })
              : disowned
            return { registry, result: 'recorded' as const }
          },
          // THE DISPOSITION FOR AN UNACQUIRED LOCK, said rather than implied (Argus r41).
          // Writing an unlocked whole-registry snapshot would drop a concurrent gateway's
          // rows and would claim a pane on the strength of a row nobody had the right to
          // read. So: nothing is written, and the caller below decides what that means.
          () => 'unwritable' as const,
        )
        // ANY PREVENTED WRITE IS A REFUSAL (Argus r48), not only an unacquired lock.
        // `withRegistry` has three ways to decline — the lock, an UNREADABLE registry
        // (`loadRegistryForMutation` sets `skipSave` and the mutator's result still comes
        // back), and a THROWN open or save — and this site treated the last two as success:
        // it confirmed the claim and served a pane whose ownership nothing durable records,
        // which is exactly the state the spec item and this record both say ends the child.
        // A deliberate `skipSave` from the mutator is NOT one of these: that is how `lost`
        // reports a contest it decided, and its result stands.
        if (ownershipWrite.prevented) {
          process.stderr.write(
            `[repl-spawn] ownership write did NOT PERSIST for ${sessionKey.slice(0, 32)} ` +
              `(${ownershipWrite.why ?? 'unknown'}) — refusing this turn and ending the child\n`,
          )
        }
        const ownershipRecorded = ownershipWrite.prevented ? 'unwritable' : ownershipWrite.result
        // A CHILD WITH A PANE NOBODY CAN FIND IS THE UNRECOVERABLE DIRECTION, and this
        // branch is the one place that can still choose. The general policy here is that a
        // registry write failure must not brick a live REPL — supervision degrades to "no
        // auto-resume" and the next write repairs it — and that remains right for every
        // other field, because losing them costs a bounded degradation.
        //
        // OWNERSHIP IS NOT ONE OF THOSE. A durable pane whose ownership was never recorded
        // is a live REPL no gateway can find again AND one any other gateway may claim while
        // this one serves it: the two-owner state, produced by the spawn that was supposed
        // to prevent it. Four rounds of this branch have established which way to fail.
        //
        // So the child is KILLED and the spawn refused. It is seconds old and serving
        // nobody; the turn fails retryably and the next one re-spawns against a registry
        // whose lock may by then be available. Refusing without killing would leave exactly
        // the unrecorded live child this branch is refusing to create.
        // CONFIRMED, on the same evidence a renewal produces: the compare-and-set landed.
        if (ownershipRecorded === 'recorded' && child.paneHandle !== undefined) {
          session.paneClaimConfirmedAt = paneClaimedAt
          // ARMED FROM THE SAME INSTANT (r49). A spawned session owns its pane exactly as an
          // adopted one does, so it self-fences on the same deadline and by the same
          // mechanism — one that does not depend on a tick this gateway may have stopped.
          if (options.replRegistryPath !== undefined) {
            armSelfFence(options.replRegistryPath, sessionKey, session)
          }
        }
        // LOST THE CONTEST. Another gateway owns this row and is serving it, so this child —
        // spawned moments ago, holding its own handle, serving nobody — is ENDED. It cannot be
        // claimed before it is spawned (the handle does not exist until then), so the ordering
        // is spawn → contend → the loser kills its own child. The asymmetry is the familiar
        // one: killing costs one respawn, leaving it alive costs a second owner on one
        // transcript.
        if (ownershipRecorded === 'lost' && child.paneHandle !== undefined) {
          try {
            child.kill()
          } catch {
            /* best-effort: the refusal below is what protects the invariant */
          }
          throw new PaneOwnershipRefusedError(
            `persistent-repl: refusing to serve session ${sessionKey.slice(0, 32)} — another gateway already ` +
              `OWNS this session's row and is serving it, so the pane ${child.paneHandle} this spawn just created ` +
              'would be a second owner of one transcript. The child was ended and this turn fails instead; it ' +
              'retries on the next turn, which will find the winner\'s session or reconcile it.',
          )
        }
        if (ownershipRecorded === 'unwritable' && child.paneHandle !== undefined) {
          try {
            child.kill()
          } catch {
            /* best-effort: the refusal below is what protects the invariant */
          }
          throw new PaneOwnershipRefusedError(
            `persistent-repl: refusing to serve session ${sessionKey.slice(0, 32)} — its pane ` +
              `${child.paneHandle} could not be RECORDED as owned (the registry lock was not acquired, so a ` +
              'write would have dropped a concurrent gateway\'s rows). A durable pane whose ownership is ' +
              'unrecorded is a REPL nothing can find again and one any other gateway may claim, so the child ' +
              'was ended and this turn fails instead. It retries on the next turn.',
          )
        }
      } catch (e) {
        // THE OWNERSHIP REFUSAL IS NOT A WRITE FAILURE and must not be swallowed by the
        // degrade policy that follows it. Keyed on a TYPE, not on the message text: matching
        // a sentence this file also composes would make the two facts — "the refusal fired"
        // and "the wording still says so" — the same fact, and this branch has paid for that
        // collapse before.
        if (e instanceof PaneOwnershipRefusedError) throw e
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
  } finally {
    releaseSpawnReservation(options, sessionKey, spawnReserver)
  }
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

class RegistryResumeRefusedError extends Error implements SubstrateClassed {
  readonly substrateErrorClass = 'repl_unreconciled' as const

  constructor(reason: string) {
    super(`persistent-repl: registry unreadable (${reason}). Cannot determine which conversation to resume; ` +
      'this turn was refused to preserve conversation continuity. Retry the turn once the registry is readable.')
  }
}

/**
 * Resolve whether a (re)spawn for `sessionKey` should `--resume` a captured
 * session. Reads the persisted registry and routes the record through the
 * (previously-DORMANT) `resolveRespawnStrategy` — the respawn-is-always-resume
 * core. Returns a directive only when the strategy resolves to a resumable
 * `session-id`; unreadable registry data refuses retryably, while genuine absence
 * returns undefined (cold/fresh spawn). Supervision-off
 * (`replRegistryPath` unset) always returns undefined → exact S1 behavior.
 */
export function resolveResumeDirective(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
): ResumeDirective | undefined {
  if (options.replRegistryPath === undefined) return undefined
  const state = readRegistryState(options.replRegistryPath)
  if (state.kind === 'absent') return undefined
  if (state.kind === 'unreadable') {
    throw new RegistryResumeRefusedError(state.reason)
  }
  if (state.droppedKeys.includes(sessionKey)) {
    throw new RegistryResumeRefusedError('the session row is invalid')
  }
  const record = normaliseRecord(state.registry[sessionKey])
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

/** The parent's spawn-time admission generation (#1237), fail-safe to `undefined`: an
 *  unwired, throwing, rejecting or non-integer reader spawns UNSTAMPED (legacy-unknown)
 *  with one stderr line — never a failed spawn. Mirrors {@link countHostedLiveWork}. */
async function readAdmissionGeneration(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
): Promise<number | undefined> {
  if (options.admissionGeneration === undefined) return undefined
  try {
    const generation = await options.admissionGeneration()
    return Number.isSafeInteger(generation) && generation! >= 0 ? generation : undefined
  } catch (err) {
    process.stderr.write(`[repl] admissionGeneration failed for key=${sessionKey.slice(0, 24)}: ${String(err)}\n`)
    return undefined
  }
}

/** The eviction guard's answer, fail-safe to 0 (an unwired or throwing counter
 *  evicts exactly as before — the guard can only ever SPARE a child). */
function countHostedLiveWork(options: PersistentReplSubstrateOptions, childGeneration: string): number {
  if (options.hostsLiveWork === undefined) return 0
  try {
    const n = options.hostsLiveWork(childGeneration)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  } catch (err) {
    process.stderr.write(`[repl] hostsLiveWork threw for generation=${childGeneration.slice(0, 8)}: ${String(err)}\n`)
    return 0
  }
}

/** A poisoned child that still hosts in-process workloads, unhooked from the pool
 *  but deliberately LEFT RUNNING. See the quarantine note in
 *  {@link getOrSpawnSession}. */
interface QuarantinedChild {
  sessionKey: string
  session: ReplSession
  options: PersistentReplSubstrateOptions
}

/** Quarantined children by child generation. A generation in here serves NO
 *  further turn (it is out of `pool`/`childByKey`) and is still alive. */
const quarantinedChildren = new Map<string, QuarantinedChild>()

/**
 * Unhook a poisoned child that still hosts live work. It is removed from the pool so nothing
 * can route a turn to it, and it is NOT terminated — its hosted workflows keep running until
 * {@link sweepQuarantinedChildren} reaps it.
 *
 * RETURNS WHETHER THE CHILD IS NOW QUARANTINED, because the caller's next decisions depend on
 * it (r57). The caller used to set `quarantined = true` from having CALLED this — the "verdict
 * computed and discarded" shape, for the fourth time on this branch — so a quarantine that did
 * not happen still suppressed the termination and the notification that would have covered it.
 */
function quarantineChild(
  sessionKey: string,
  session: ReplSession,
  options: PersistentReplSubstrateOptions,
  hosted: number,
  /** The pool entry the CALLER resolved through, so this only ever removes that one (r56).
   *  It could not name what it owned before, which the enumeration counts as the finding
   *  rather than as a site to leave alone. */
  ownEntry: Promise<ReplSession> | undefined,
): boolean {
  // THE GUARD BELONGS TO THE EFFECT, NOT TO THE FUNCTION (Argus r57, and it is the mirror of
  // the four rounds before it). "Do not delete somebody else's pool entry" scopes to the
  // `pool.delete` LINE. As an early `return` it became "do none of this function's work", and
  // the three obligations that have nothing to do with the pool went with it: the child stayed
  // in `childByKey`, it was never registered with the quarantine reaper, and it got no exit
  // notification — **a live child leaked, invisible to everything that would have reaped it.**
  //
  // A missing guard evicts a map entry; a guard scoped too widely leaks a process. The second
  // is the worse direction, and this is the first time on this branch we have found one.
  if (ownEntry === undefined || pool.get(sessionKey) === ownEntry) pool.delete(sessionKey)
  if (childByKey.get(sessionKey) === session.child) childByKey.delete(sessionKey)
  quarantinedChildren.set(session.childGeneration, { sessionKey, session, options })
  process.stderr.write(
    `[repl] QUARANTINED abandon-poisoned session=${session.sessionId.slice(0, 8)} generation=${session.childGeneration.slice(0, 8)} — unhooked from the pool (it will serve no further turn) but left RUNNING because it hosts ${hosted} live workflows; reaped once they finish\n`,
  )
  // A quarantined child is outside the pool, so the supervision watchdog can no
  // longer report its death. If it dies while still hosting work, its hosted runs
  // must learn NOW — otherwise they wait out the 90-minute hang watchdog, which is
  // the ~170-minute lag this whole change exists to remove.
  fireAndForget(
    'persistent-repl.quarantine-exit',
    session.child.exited.then(async () => {
      if (quarantinedChildren.get(session.childGeneration) === undefined) return
      quarantinedChildren.delete(session.childGeneration)
      if (countHostedLiveWork(options, session.childGeneration) > 0) {
        await notifyEvictedChild(options, sessionKey, session.childGeneration, 'quarantined child exited with live work')
      }
    }),
  )
  // The child is registered with the reaper and out of the routing maps, which is what
  // "quarantined" means. Reported rather than assumed.
  return quarantinedChildren.get(session.childGeneration) !== undefined
}

/** Terminate quarantined children whose hosted work has drained. Fired (not
 *  awaited) from every {@link getOrSpawnSession} — the substrate's only regular
 *  heartbeat — and exported so tests can drive it deterministically. A child that
 *  still hosts work is never touched. Returns how many were reaped. */
export async function sweepQuarantinedChildren(): Promise<number> {
  let reaped = 0
  for (const [generation, entry] of [...quarantinedChildren]) {
    if (entry.session.hasChildExited()) {
      quarantinedChildren.delete(generation)
      continue
    }
    if (countHostedLiveWork(entry.options, generation) > 0) continue
    quarantinedChildren.delete(generation)
    process.stderr.write(
      `[repl] reaping quarantined generation=${generation.slice(0, 8)} — its hosted workflows have finished\n`,
    )
    await terminateChild(entry.session.child)
    reaped += 1
  }
  return reaped
}

/** Terminate EVERY quarantined child, hosted work or not. Called only from
 *  `shutdownAllPersistentRepls` — at gateway teardown the hosted workflows are
 *  going away regardless, and a quarantined child is outside the pool, so the
 *  shutdown loop would otherwise orphan its process.
 *
 *  #518 — AND THIS IS THE SITE WHERE A DEPLOY IS GUARANTEED TO KILL LIVE WORK. A
 *  child is quarantined precisely BECAUSE it still hosts running workflows (the
 *  eviction guard deferred its reaping), so "hosted work or not" is in practice
 *  always "hosted work". It reported nothing at all: the `child.exited` hook
 *  `quarantineChild` installs returns early when the entry is already gone from
 *  the map, and the delete below happens first. So each kill is now reported as
 *  the gateway shutdown it is, before it happens. */
export function shutdownQuarantinedChildren(
  shutdownAt: number = Date.now(),
): { reports: PendingShutdownKillReport[]; awaitingExit: ShutdownExitWatch[] } {
  const owed: PendingShutdownKillReport[] = []
  const awaitingExit: ShutdownExitWatch[] = []
  for (const [generation, entry] of [...quarantinedChildren]) {
    quarantinedChildren.delete(generation)
    // MARK, THEN KILL. Both are cheap and local; neither may sit behind a sink. The
    // owed live report is RETURNED for the caller's bounded delivery phase — awaiting
    // it here would put an unbounded call from a sink we do not own between this
    // child's kill and the next one's (see `gateway-shutdown-kill.ts`, the constraint
    // at the top).
    //
    // Sampled BEFORE the kill for the reason that module also gives: a quarantined
    // child can have died on its own while we were keeping it alive for its hosted
    // work, and that death is not this deploy's to claim.
    const report = recordGatewayShutdownKill(
      entry.options,
      entry.sessionKey,
      generation,
      shutdownAt,
      sampleLivenessBeforeShutdownKill(() => entry.session.hasChildExited()),
      // Recorded so this generation's death can be CONFIRMED later rather than assumed
      // from the entry — and a quarantined generation needs it most, because the row's
      // own pid belongs to the replacement child that spawned over it.
      readChildPid(entry.session.child),
    )
    owed.push(report)
    // Same rule as the pooled path: SIGNAL here, and let the caller's shared pass
    // establish whether it actually died. Only an observed exit attributes the kill.
    let signalDelivered = false
    try {
      entry.session.child.kill()
      signalDelivered = true
    } catch {
      /* the signal failed; a later death is then not ours to claim */
    }
    awaitingExit.push({ report, child: entry.session.child, signalDelivered })
  }
  return { reports: owed, awaitingExit }
}

/** Test/diagnostic seam: how many children are quarantined right now. */
export function quarantinedChildCount(): number {
  return quarantinedChildren.size
}

/** Deliver an eviction to the durable crash sink with the EVICTED generation.
 *  Mirrors the supervision watchdog's `onChildCrash` call for a pid-dead child;
 *  this is the edge that watchdog structurally cannot observe. */
export async function notifyEvictedChild(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  childGeneration: string,
  reason: string,
): Promise<void> {
  if (options.onChildCrash === undefined) return
  try {
    await options.onChildCrash({
      sessionKey,
      generationKey: childGeneration,
      // #518 — an eviction is the pool's own doing, but it is a FAULT response (an
      // abandon-poisoned child), not a deploy. It stays on the `child-died` side of
      // the discriminant: crediting it to a gateway shutdown would be the negative
      // half of the spec item's acceptance failing.
      cause: 'child-died',
      detail: `pooled child evicted (${reason}) — every in-process workload it hosted died with it`,
    })
  } catch (err) {
    process.stderr.write(
      `[repl] onChildCrash sink threw on eviction generation=${childGeneration.slice(0, 8)}: ${String(err)}\n`,
    )
  }
}


/**
 * TAKE THE SESSION KEY BEFORE ANY PROCESS EXISTS (#539 r47) — see the ordering invariant at
 * the top of `boot-adoption.ts`.
 *
 * A fresh spawn becomes capable of corrupting the transcript the instant `PtyHost.spawn`
 * starts a `claude --resume <id>`: it appends through startup and readiness, and killing the
 * loser afterwards does not unwrite what it appended. The pane claim cannot help — there is
 * no pane yet — so what is contended for here is the KEY.
 *
 * FAIL-CLOSED, like every other write whose correctness rests on the lock: an unacquired lock
 * answers `unwritable`, and the caller refuses rather than spawning a process it cannot
 * reserve. An unsupervised substrate (no registry) has no shared state to race over, so it
 * proceeds — that is the same reasoning `beginBootAdoption` uses for a missing registry.
 */
function reserveSpawnForKey(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  reserver: string,
  now: number,
  ourPid: number,
  /** What a row for this key must carry to be READABLE — see the note at the write below. */
  identity: { sessionId: string; cwd: string; channelName: string; hasSession: boolean },
): 'reserved' | 'taken' | 'unwritable' | 'unsupervised' {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return 'unsupervised'
  try {
    const write = withOwnedRegistry<'reserved' | 'taken' | 'unwritable'>(
      registryPath,
      (registry) => {
        const prev = registry[sessionKey]
        if (
          prev !== undefined &&
          spawnReservationBlocksUs(prev, {
            ours: reserver,
            now,
            ourPid,
            ...(options.claimantLiveness !== undefined ? { liveness: options.claimantLiveness } : {}),
          })
        ) {
          return { registry, result: 'taken', skipSave: true as const }
        }
        // A row may not exist yet (a cold first turn), and the reservation still has to be
        // durable — so one is created. IT MUST BE SCHEMA-VALID, and that is not a nicety: a
        // row carrying only a reservation fails `isMinimalRecord`, and the registry layer then
        // DROPS it on every subsequent read and refuses to save over a file it had to repair
        // (`loadRegistryForMutation`'s corrupt-skip). The stub would therefore be
        // unmaintainable — impossible to release, and permanently answering `undecided` for
        // that key, which refuses every later turn with no TTL to end it. Measured, not
        // reasoned: a reservation-only row survived its own release and the log showed the
        // drop.
        //
        // So the reservation writes the identity the spawn is about to write anyway. Nothing
        // here is invented: these are the same values the argv was built from.
        registry[sessionKey] = reservePaneSpawn(
          prev ?? ({ sessionKey, sessionId: identity.sessionId, cwd: identity.cwd, channelName: identity.channelName, has_session: identity.hasSession } as ReplRegistryRecord),
          { by: reserver, now, pid: ourPid },
        )
        return { registry, result: 'reserved' }
      },
      () => 'unwritable',
    )
    // A RESERVATION THAT DID NOT PERSIST IS NOT A RESERVATION (r48): the next gateway reads the
    // FILE, not our intention. Same fail-closed answer as an unacquired lock.
    return write.prevented ? 'unwritable' : write.result
  } catch {
    return 'unwritable'
  }
}

/** Give the reservation back, CAS'd on it still being ours. Best-effort: the TTL is the
 *  backstop, and a failed release costs one bounded refusal rather than a lost key. */
function releaseSpawnReservation(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  reserver: string,
): void {
  // GIVEN UP IN THIS PROCESS FIRST, AND UNCONDITIONALLY (r59, lost to a bad mutation-restore
  // and re-applied with its case in r61). The durable release can fail — an unacquired lock, a
  // registry that has become unwritable — and the row then still names this reserver. If the
  // process also went on claiming to HOLD it, `spawnReservationBlocksUs` would treat the
  // abandoned reservation as a live in-process owner and refuse this key to every later turn
  // until the TTL, which is precisely the wedge the local register was introduced to prevent.
  // The row's TTL is the backstop for other processes; this line is the backstop for ours.
  dropLocalOwnership(reserver)
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return
  try {
    withOwnedRegistry(
      registryPath,
      (registry) => {
        const prev = registry[sessionKey]
        const released = prev === undefined ? undefined : releasePaneSpawnReservation(prev, reserver)
        if (released === undefined) return { registry, result: undefined, skipSave: true as const }
        // NO STUB TO CLEAN UP: the reservation wrote a schema-VALID row (see the note at
        // `reserveSpawnForKey`), so removing the reservation fields leaves a row the registry
        // can still read — a session with no pane and no claim, which is exactly what "this
        // spawn did not finish" means and what the next turn should find.
        registry[sessionKey] = released
        return { registry, result: undefined }
      },
      () => undefined,
    )
  } catch {
    /* the TTL is the backstop */
  }
}

/**
 * The spawn refused because its pane's OWNERSHIP could not be durably recorded (#539 r41).
 *
 * A distinct type rather than a distinguished message: the `catch` around the registry
 * write deliberately swallows write failures (a live REPL must not be bricked by one), and
 * this refusal has to pass through it. Keying that on text would make the refusal's
 * survival depend on its own wording.
 */
class PaneOwnershipRefusedError extends Error implements SubstrateClassed {
  /**
   * ITS CLASS TRAVELS WITH IT (r42). `repl_unreconciled` is the vocabulary this refusal
   * belongs to — the same one the boot-adoption gate's refusal uses — and every stamped
   * class except `rate_limited` / `http_status` skips the credential cooldown. Stamped on
   * the error rather than left to a downstream regex, because a refusal that has to be
   * recognised by its prose is one rewording away from costing a credential.
   */
  readonly substrateErrorClass = 'repl_unreconciled' as const
}

/** How many times a turn that lost the pool to a concurrent publish may re-enter
 *  {@link getOrSpawnSession} before refusing. Contention resolves on the first re-entry in
 *  every case we can construct; the bound exists so that a pathological interleaving degrades
 *  to a RETRYABLE refusal rather than to an unbounded recursion. */
const STALE_TURN_REENTRY_LIMIT = 3

/**
 * The spawn-time profile a request presents to the warm-reuse guard: the `--tools`
 * surface (`spec.tools` names, comma-joined — the `session.toolSurface` rule) and
 * whether the tool bridge is requested. ONE definition: the reuse guard below and
 * the #1237 replacement attestation (`generation-replacement.ts`) both read it, so
 * an attested replacement is exactly what the next dispatch will accept.
 */
export function requestedReplProfile(
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
): { toolSurface: string; toolBridge: boolean } {
  return {
    toolSurface: spec.tools.map((t) => t.name).join(','),
    toolBridge: options.enableToolBridge === true && replToolBridgeRef.current !== undefined,
  }
}

export async function getOrSpawnSession(
  sessionKey: string,
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
  forceResume?: ResumeDirective,
  /** INTERNAL. Counts this turn's re-entries after losing the pool to a concurrent publish
   *  (see the stale-turn branch below). Callers pass nothing. */
  staleTurnReentries: number = 0,
): Promise<ReplSession> {
  // #539 — NOTHING MAY SPAWN ON A KEY WHOSE SURVIVING REPL HAS NOT BEEN RECONCILED.
  // Under the herdr host a gateway restart leaves the previous REPL running, so a
  // cold spawn here would put a second `claude` on a transcript that still has an
  // owner — the invariant this repo enforces by killing the old process. The pass
  // either re-adopts that pane (and it is in `pool` by the time this line completes)
  // or closes it; either way the key then has one owner or none.
  //
  // `begin`, NOT `await` alone: THE TRIGGER AND THE GATE ARE THE SAME CALL,
  // deliberately. The boot wiring also starts this (`adapters/claude-code/index.ts`,
  // before the watchdog is armed) and that is the ordering the issue asks for — but a
  // gate that only waits for a pass somebody else remembered to start is a gate that
  // silently does nothing the day a new call path reaches the pool. It is idempotent
  // per key, so the second caller joins the first pass rather than racing it, and it
  // is a no-op returning `no-handle` when there is no registry or no durable handle —
  // which is every test and every unsupervised substrate.
  //
  // AND THE VERDICT IS READ. Awaiting it only for the ORDERING was the defect a gate
  // review caught: the pass distinguishes "the other owner is gone" from "I could not
  // establish that", and then this function spawned on either. Everything below
  // resumes a transcript, so an unestablished owner means a SECOND process on it.
  const reconciled = await beginBootAdoption(options, sessionKey)
  const permitted = adoptionPermitsSpawn(reconciled)
  if (!permitted.ok) {
    // REFUSE, LOUDLY AND RETRYABLY. Not a cold spawn with a fresh session id either:
    // that silently starts an empty conversation where the user expects theirs, which
    // is the same class of harm as the stale-resume picker this tree already refuses
    // to paper over. The next turn re-runs the pass — an `undecided` outcome is
    // deliberately not cached — so a transient failure to see herdr costs one turn,
    // and a real unreaped owner keeps costing turns until an operator or the process
    // table settles it.
    throw new Error(
      `persistent-repl: refusing to resume session ${sessionKey.slice(0, 32)} — a previous REPL for it may ` +
        `still be running and could not be accounted for (${permitted.reason}). Starting a second process on ` +
        'one transcript corrupts it, so this turn fails instead. It retries on the next turn.',
    )
  }
  // Heartbeat for the quarantine reaper. Dispatch is the substrate's only regular
  // tick, and a quarantined child must not outlive its hosted work. FIRED, not
  // awaited: adding an await here would reorder the synchronous prefix two
  // concurrent dispatches rely on, and a reap is never on this turn's path.
  fireAndForget('persistent-repl.quarantine-sweep', sweepQuarantinedChildren())
  // P0-1 defense-in-depth (Codex r1 [P2]): the native-MCP tool bridge is a
  // SPAWN-time property of the REPL, exactly like the tool surface. Compute what
  // THIS request would attach so the reuse guard can refuse to serve a
  // bridge-mismatched warm child — making the bridge restriction LOCAL, not
  // dependent on `substrate_instance_id` keying (today they align, so this never
  // fires; it survives a future edit that varies the bridge at a finer grain).
  const { toolSurface: requestedToolSurface, toolBridge: requestedToolBridge } = requestedReplProfile(options, spec)
  // ── THE COLD PATH MUST NOT SUSPEND, AND "READ FIRST" IS NOT ENOUGH ──────────
  // Two concurrent dispatches on one key de-duplicate onto a single spawn only
  // because NOTHING SUSPENDS between this read and the `pool.set` at the end of the
  // function: the second caller's `pool.get` observes the first's in-flight promise
  // and awaits it. That is a property of the WHOLE cold path, not of the read's
  // position — an `await` placed after this line and before the `pool.set` reopens
  // the window just as widely, because the second caller then reads a pool the first
  // has not written yet and both spawn.
  //
  // An earlier revision of this function got that wrong. It hoisted the pool read
  // above an unconditional `await options.resolveExtraMcpServers()` and a comment
  // here claimed the hoist "restores the await-free window" — which was a claim about
  // a mode the code did not enter. The resolver is awaited for the WARM-REUSE
  // COMPARISON only, and the fingerprint of zero installed servers is `''`, so the
  // suspension fired on every cold start for every owner: two `claude` children on
  // one transcript (the one-owner-per-transcript violation `open/composer.ts`
  // documents a real second concurrent producer for), one of which outlived
  // `shutdownAllPersistentRepls()` still holding an open MCP config file.
  //
  // So the resolve now happens INSIDE the warm branch, where the function has
  // already awaited `existing` and a concurrent caller is therefore looking at the
  // same warm session rather than at an empty pool. The cold path is once again
  // straight-line from read to set. `__tests__/owner-mcp-servers.test.ts` pins both
  // halves: two concurrent cold dispatches spawn exactly ONE child, and a cold start
  // calls the resolver exactly ONCE — `spawnSession`'s own read, which it has always
  // done. A second call there would mean this await is back above the branch.
  const existing = pool.get(sessionKey)
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
      // Reuse guards gate serving a turn on the warm child; EVERY one must pass or
      // the child is evicted + respawned, or an adopted parent refuses the turn
      // while native-child liveness remains unknown (resuming the captured session when
      // supervised, so conversational context survives the respawn). The third,
      // `freshMcpServers`, is documented at its own declaration below:
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
      const freshCredential = session.authFingerprint === authFingerprintFor(options.env, options.sinkTokenPath)
      // INSTALLED-MCP-SERVER guard: `mcpServers` is read once by `claude` at
      // startup, so a warm child cannot learn about a server the owner installed
      // (or approved, or revoked, or re-keyed) since it spawned. Evicting +
      // respawning here is what makes a settings change take effect on the very
      // next turn; because the fingerprint is deterministic over equal
      // configuration, an unchanged set never fires it, so the pool does not
      // thrash. The respawn resumes the captured session, so the conversation
      // survives the swap.
      //
      // RESOLVED HERE, not at the top of the function: the resolver is async, and on
      // the COLD path an await between the `pool.get` above and the `pool.set` below
      // double-spawns (see the block at the `pool.get`). Inside this branch the
      // function has already awaited `existing`, so a concurrent caller is looking at
      // the same warm session, not at an empty pool. Computed with the identical
      // double gate `spawnSession` applies, so the fingerprint compared here is
      // exactly the one a spawn would stamp — a mismatch in the gating would mean
      // either a warm child that never picks up an install, or one evicted on every
      // single turn.
      const requestedMcpFingerprint = mcpSurfaceFingerprint(
        options.enableToolBridge === true && options.resolveExtraMcpServers !== undefined
          ? await options.resolveExtraMcpServers()
          : [],
      )
      const freshMcpServers = session.mcpFingerprint === requestedMcpFingerprint
      // ABANDON-POISON guard (2026-06-18 warm-session hang fix): a session whose
      // prior turn was abandoned (caller timeout / substrate turn-timeout) is left
      // with a RUNAWAY turn still executing on the warm child + a desynced
      // dev-channel correlation. Reusing it lands the next turn's inject on a busy
      // REPL whose stale-reply debt strips the next reply's turn_id → the turn
      // never delivers (the cascade). Evict + respawn a clean REPL instead, exactly
      // like the freshness guards below. NOT silent — log so the eviction is
      // observable in prod.
      if (freshSurface && freshBridge && freshCredential && freshMcpServers && !session.poisoned) {
        return session
      }
      // Adoption cannot reconstruct native-child leases. A quiet parent or a zero
      // hosted-work count does not establish that those children have finished.
      // Keep its ownership in the pool: quarantine would permit a duplicate owner,
      // and reuse would bypass the failed credential/tool/poison guards above.
      if (session.adopted) {
        throw new PaneOwnershipRefusedError(
          'persistent-repl: refusing adopted parent refresh — native-child liveness is unknown; ' +
          'the existing parent remains owned and this turn cannot run until lifecycle reconciliation',
        )
      }
      // Set when the poisoned child was QUARANTINED rather than evicted: it stays
      // alive (it hosts live work) and must not be terminated or reported dead.
      let quarantined = false
      if (session.poisoned) {
        // THE EVICTION GUARD (2026-09-03 root cause, 33% of trident run deaths),
        // REWORKED after the cross-model review's blocker #2 (2026-09-04).
        //
        // Terminating this child SIGKILLs every in-process workload it hosts — for
        // the trident launcher that is every other run's Argus panel, arbiter and
        // terminal/cleanup steps (only the codex forge build is detached). So a
        // child that hosts live work must NOT be killed here. That part stands.
        //
        // The first cut drew the wrong conclusion from it: it CLEARED
        // `session.poisoned` and RETURNED that same child. Sparing a child and
        // REUSING it are separate decisions and only the first one is safe — reuse
        // is precisely what the poison exists to forbid. The abandoned turn is still
        // executing on that REPL; its stale-reply debt strips the next reply's
        // turn_id and the next turn never delivers, which is the cascade
        // abandon-poison was introduced to stop. Clearing the flag also discarded
        // the OTHER meanings of `poisoned` — resume-picker recovery and auth-invalid
        // set it too, and each needs its respawn to actually happen.
        //
        // QUARANTINE takes both halves. The child is unhooked from the pool so no
        // later turn can be routed to it, left RUNNING so its hosted workflows
        // finish, and reaped by `sweepQuarantinedChildren()` once its hosted count
        // reaches zero. `poisoned` is never cleared. This turn falls through to a
        // clean spawn, exactly like every other eviction.
        //
        // Chat/synthesis substrates are untouched: they wire no `hostsLiveWork`, so
        // they answer 0 and evict as before.
        const hosted = countHostedLiveWork(options, session.childGeneration)
        if (hosted > 0) {
          // FROM WHAT THE FUNCTION REPORTS, not from having called it (r57).
          quarantined = quarantineChild(sessionKey, session, options, hosted, existing)
          // The quarantined child keeps ownership of its session transcript for as
          // long as it runs, so the replacement must NOT `--resume` the same id.
          // Every other eviction buys the Argus-r3 one-owner invariant by awaiting
          // the old child's exit first; a child we are deliberately keeping alive
          // cannot give us that, so the replacement is FRESH instead.
          evictedResume = undefined
          evictedForceFresh = true
        } else {
          process.stderr.write(
            `[repl] evicting abandon-poisoned warm session=${session.sessionId.slice(0, 8)} generation=${session.childGeneration.slice(0, 8)} key-respawn (prior turn abandoned before reply; clean respawn for the next turn)\n`,
          )
        }
      }
      if (!quarantined) {
        const evictionReason = session.poisoned
          ? 'abandon-poison'
          : !freshSurface
            ? 'tool-surface mismatch'
            : !freshBridge
              ? 'tool-bridge mismatch'
              : 'credential rotation'
        // Evict, then AWAIT the old child's exit before falling through to spawn so a
        // supervised `--resume` replacement (same sessionId) never co-owns the session
        // transcript with the dying child (the Argus-r3 one-owner invariant). The
        // credential-freshness path fires on every token rotation (regularly), unlike
        // the rarely-firing tool-surface mismatch, so honoring the await here matters.
        // ONLY OUR OWN ENTRY (r56). `existing` is the promise this turn resolved through, and
        // the `await` above is a suspension point: a concurrent turn can evict and republish
        // under this key while we wait, and evicting THAT is taking a live REPL out of the map
        // every turn resolves through. `childByKey` one line down has been identity-guarded
        // since r30 — two maps, two rules, one line apart, which is the contrast that was
        // visible at every one of these sites.
        if (pool.get(sessionKey) === existing) pool.delete(sessionKey)
        if (childByKey.get(sessionKey) === session.child) childByKey.delete(sessionKey)
        await terminateChild(session.child)
        // LATCH THE DEATH. An eviction is a child exit the supervision watchdog can
        // never see: the registry is repointed at the replacement child before its
        // next tick, so the dead generation's owner learned nothing until the 90-min
        // hang watchdog reaped the corpse (~170 min later, measured). Tell the durable
        // sink NOW, with the EVICTED generation, so crash recovery runs on the next
        // tick. Best-effort: a sink failure must never block the respawn.
        await notifyEvictedChild(options, sessionKey, session.childGeneration, evictionReason)
      }
    } else {
      // Same rule as the eviction above: the child has exited, but the ENTRY may already be
      // somebody else's.
      if (pool.get(sessionKey) === existing) pool.delete(sessionKey)
    }
  }
  // Precedence: an explicit caller `forceResume` (admin/watchdog) wins; else a
  // resume-picker MISS forces a fresh spawn (`evictedForceFresh`, breaking the
  // stale-resume loop); else a resume-picker HIT resumes the recovered transcript
  // (`evictedResume`); else the normal registry-resolved directive.
  const resume = forceResume
    ?? (evictedForceFresh ? undefined : (evictedResume ?? resolveResumeDirective(sessionKey, options)))
  // A STALE TURN DOES NOT PUBLISH OVER THE WINNER — AND DOES NOT SERVE IT UNCHECKED EITHER
  // (Argus r57, corrected r58). Guarding the DELETES was only half of it: this turn resolved
  // through `existing`, and if the map now holds something else, another turn published while
  // we were deciding. Overwriting that entry takes a live REPL out of the map just as surely
  // as deleting it would — the harm is "the winner is no longer the pool entry", and
  // by-delete versus by-overwrite is a detail of how.
  //
  // BUT THE FIRST VERSION RETURNED THE WINNER'S PROMISE DIRECTLY, AND THAT IS A PRIVILEGE
  // BOUNDARY. The winner was published for a DIFFERENT request: the reuse guards above
  // (tool surface, tool bridge, credential freshness, abandon-poison, child liveness) are
  // exactly what decides whether a pooled session may serve THIS one, and returning the raw
  // promise skipped all of them. A turn asking for `[Read]` could be handed a session spawned
  // with `[Write]` — the inheritance the surface guard at the top of this block exists to
  // forbid, arriving through the back door.
  //
  // SO THE LOSER RE-ENTERS instead of hand-rolling a second opinion. `getOrSpawnSession` IS
  // the decision procedure for "there is a pooled entry for this key, may it serve me" — it
  // validates, and when the answer is no it EVICTS and respawns properly rather than
  // publishing over the entry. A re-entry is what this turn would have done had it arrived a
  // microsecond later, which is the only defensible answer to losing a race. Validating
  // inline against a copy of the predicate would have been a second copy to keep in step,
  // and this file has now produced four defects of exactly that shape.
  //
  // The re-entry repeats `beginBootAdoption` (idempotent per key) and the quarantine
  // heartbeat (a fired sweep, never on the turn's path). It does NOT carry this turn's
  // `evictedResume` / `evictedForceFresh` across: those describe the session WE evicted, and
  // the re-entered turn decides against whatever is pooled now — if it evicts that session
  // too, it captures that session's own recovery directives.
  const currentBeforePublish = pool.get(sessionKey)
  if (currentBeforePublish !== undefined && currentBeforePublish !== existing) {
    if (staleTurnReentries >= STALE_TURN_REENTRY_LIMIT) {
      // A REFUSAL, NOT A SPAWN, and classed so it costs a turn rather than a credential
      // (r42's vocabulary). Repeatedly losing the key means somebody else is actively
      // serving it; spawning anyway is the two-owner outcome this whole change exists to
      // prevent, and publishing anyway is the r57 defect.
      throw new PaneOwnershipRefusedError(
        `persistent-repl: refusing to spawn for session ${sessionKey.slice(0, 32)} — the pool entry for it ` +
          `was replaced by a concurrent turn ${staleTurnReentries} times while this turn was deciding. ` +
          'It retries on the next turn.',
      )
    }
    return getOrSpawnSession(sessionKey, options, spec, forceResume, staleTurnReentries + 1)
  }
  const spawning = spawnWithChannelWedgeRespawn(sessionKey, options, spec, resume)
  pool.set(sessionKey, spawning)
  // MARKED PENDING FOR AS LONG AS IT IS PENDING. A cold spawn is a dispatch that has
  // already committed to this child — it just cannot say so through `activeTurn` /
  // `turnSlotHeld` yet, because the session those live on does not exist until this
  // promise resolves. `evictWarmReplsForMcpSurfaceChange` reads this map to tell a
  // committed cold spawn apart from a genuinely idle warm child; see its docblock. A
  // `Promise` cannot be asked whether it has settled, and asking by awaiting it is the
  // one observation that changes the answer — so the answer is recorded here instead.
  // Cleared on BOTH outcomes, and identity-guarded so a settle from a superseded spawn
  // cannot clear the entry of the one that replaced it.
  pendingSpawns.set(sessionKey, spawning)
  const clearPending = (): void => {
    if (pendingSpawns.get(sessionKey) === spawning) pendingSpawns.delete(sessionKey)
  }
  spawning.then(clearPending, clearPending)
  // THE SESSION REMEMBERS THE PROMISE IT WAS PUBLISHED UNDER (r55). It cannot do this itself:
  // the promise exists before the session does, and this is the only scope that holds both.
  spawning.then(
    (s) => {
      s.pooledAs = spawning
    },
    () => undefined,
  )
  spawning.catch(() => {
    // IDENTITY-GUARDED LIKE THE OTHERS (r55). This delete was unconditional: a spawn that
    // rejects AFTER a replacement has been published under the same key would evict the
    // replacement. Same shape as the exit teardown's arms, found by sweeping for the guard
    // rather than by being told about this site.
    if (pool.get(sessionKey) === spawning) pool.delete(sessionKey)
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

export async function injectMessage(
  session: ReplSession,
  text: string,
  turnId: string,
  additional = false,
): Promise<void> {
  const channelPort = session.channelPort
  if (channelPort === undefined) {
    throw new Error('persistent-repl: inject before the dev-channel bound a port')
  }
  // THIS CHILD'S credential, not the instance root: the child validates the inbound
  // header against the `SINK_TOKEN` it was baked with (`dev-channel-impl.ts`), and
  // that is now per-incarnation. Derived rather than stored so it cannot drift from
  // what the sink authorizes.
  const resp = await fetch(`http://127.0.0.1:${channelPort}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': sink.credentialFor(session) },
    // `turn_id` round-trips through the dev-channel onto the matching reply so
    // `onReply` can correlate the completion to this exact turn (Argus r5 fix).
    body: JSON.stringify({ text, turn_id: turnId, additional }),
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
