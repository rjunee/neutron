/**
 * build-repl-argv.ts — construct the interactive `claude` REPL argv.
 *
 * LIFTED from Nova `gateway/gateway-core.ts` `buildSpawnCommand` (§ 1 #1,
 * ◆ ADAPTED-AT-BOUNDARY). Every flag is kept verbatim INCLUDING the hidden
 * experimental `--dangerously-load-development-channels` (the dev-channel
 * injection seam) plus `--mcp-config`, `--settings`,
 * `--append-system-prompt-file`, `--add-dir`, `--model`. There is NO `-p` /
 * `--print` — this is an interactive session, which is the whole point (the
 * June-15 billing cap exempts interactive Max sessions; see brief § 7).
 *
 * ONLY delta from Nova: no tmux wrapper. Nova emitted a shell string
 * (`cd '<cwd>' && claude … `) handed to `tmux new-window`. Here we return a
 * plain argv `string[]` handed straight to the `PtyHost` (the `cwd` is a
 * spawn option, not a `cd &&` prefix), so there is no shell, no quoting, and
 * no tmux. Resume is `--resume <id>` on respawn; a fresh spawn pins the
 * session UUID up-front via `--session-id <id>` (Neutron's deterministic
 * convention) instead of Nova's legacy `-n`.
 */

export interface BuildReplArgvInput {
  /** Binary path. Default `process.env.CLAUDE_BIN ?? 'claude'`. */
  claudeBin?: string
  /**
   * Session UUID. On a fresh spawn it is pinned via `--session-id`; on a
   * respawn (`resume: true`) it is replayed via `--resume`. Either way the
   * substrate knows the id deterministically.
   */
  sessionId: string
  /** True ⇒ `--resume <sessionId>`; false ⇒ `--session-id <sessionId>`. */
  resume: boolean
  /** Dev-channel name → `--dangerously-load-development-channels server:<name>`. */
  channelName: string
  /** Path to the generated `--mcp-config` JSON (registers the dev-channel). */
  mcpConfigPath: string
  /** Path to the generated `--settings` JSON (wires the enforce-reply Stop hook). */
  settingsPath: string
  /** Path to the agent-base system prompt → `--append-system-prompt-file`. */
  appendSystemPromptFile: string
  /** Model id → `--model`. Emitted LAST so nothing shadows it. */
  model: string
  /** Optional extra allowed dir → `--add-dir`. Typically the instance home. */
  addDir?: string
  /**
   * When true, append `--dangerously-skip-permissions`. Managed headless
   * REPLs MUST set this (there is no human to approve tool calls); Open-tier
   * local dev may leave it off.
   */
  skipPermissions?: boolean
  /**
   * Built-in tool surface allow-list (Core-namespace + built-in names, e.g.
   * `['Read','Grep']`). `--tools` is ALWAYS emitted (default-deny): empty /
   * undefined → `--tools ""` which disables every built-in tool. This is the
   * SECURITY-CRITICAL port of the retired per-turn path's tool restriction
   * (Codex-r1-P1): the history-import substrate processes UNTRUSTED user data
   * (raw ChatGPT exports) under `--dangerously-skip-permissions`, so a
   * prompt-injection ("use Bash to cat ~/.claude/.credentials.json") would
   * AUTO-EXECUTE without this gate. The restriction MUST apply whether or not
   * `skipPermissions` is set. `--allowed-tools` is NOT used — empirically it
   * does not restrict the surface; only `--tools` gates the built-in set.
   */
  tools?: ReadonlyArray<string>
}

/** Build the interactive `claude` argv as a plain string array (no shell, no
 *  tmux). The `PtyHost` spawns this directly with `cwd` + scrubbed `env`. */
export function buildReplArgv(input: BuildReplArgvInput): string[] {
  const claudeBin = input.claudeBin ?? process.env['CLAUDE_BIN'] ?? 'claude'
  const argv: string[] = [claudeBin]

  if (input.resume) {
    argv.push('--resume', input.sessionId)
  } else {
    argv.push('--session-id', input.sessionId)
  }

  argv.push('--dangerously-load-development-channels', `server:${input.channelName}`)
  argv.push('--mcp-config', input.mcpConfigPath)
  argv.push('--settings', input.settingsPath)
  // Default-deny tool surface (SECURITY-CRITICAL — see `tools` field docs).
  // Empty/undefined → `--tools ""` (disables every built-in); populated →
  // `--tools <comma-list>` so only the named built-ins survive.
  if (input.tools === undefined || input.tools.length === 0) {
    argv.push('--tools', '')
  } else {
    argv.push('--tools', input.tools.join(','))
  }
  if (input.skipPermissions === true) {
    argv.push('--dangerously-skip-permissions')
  }
  argv.push('--append-system-prompt-file', input.appendSystemPromptFile)
  if (input.addDir !== undefined) {
    argv.push('--add-dir', input.addDir)
  }
  // Model LAST so nothing shadows it (Nova invariant).
  argv.push('--model', input.model)
  return argv
}
