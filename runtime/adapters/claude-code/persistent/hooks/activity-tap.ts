#!/usr/bin/env bun
/**
 * Pre/PostToolUse hook — the ACTIVITY INSPECTOR's tool tap.
 *
 * WHY THIS EXISTS AT ALL (read before "why not just use the event stream?"):
 * the persistent-REPL adapter's `Event` stream carries almost nothing. The 1:1
 * bridge in `repl-session.ts` pushes exactly ONE `token` holding the entire
 * finished reply, a `completion`, and periodic synthetic `status` keepalives
 * (`pool.ts`). It emits NO `thinking`, NO `tool_call`, NO `tool_result_ack` for
 * the agent's native tools. So teeing the event stream alone answers "is the
 * process alive?" and nothing else — it can never say WHAT the agent is doing,
 * which is exactly what the owner reads off tmux in Vajra ("Bash: bun test",
 * "Read foo.ts").
 *
 * CC's tool hooks are where that information actually lives. This hook is the
 * sibling of `todo-sync.ts` (same shape: a small `bun` subprocess CC invokes with
 * a JSON payload on stdin, doing one notify-only thing) but it is wired on BOTH
 * phases with an unscoped matcher, so every tool the agent touches is reported:
 *
 *   PreToolUse  (TAP_PHASE=pre)  → "started Bash: bun test"
 *   PostToolUse (TAP_PHASE=post) → "finished Bash"
 *
 * Both phases matter. A `pre` with no matching `post` for minutes IS the hang
 * signal — a wedged `Bash`/`AskUserQuestion` shows as started-never-finished,
 * which no single-phase tap and no liveness pulse can express.
 *
 * PHASE comes from `TAP_PHASE`, baked into the hook command per matcher by
 * `build-settings.ts` — deliberately NOT read from the stdin payload's
 * `hook_event_name`, so the phase is correct regardless of CC payload-shape
 * drift across versions.
 *
 * TRANSPORT: the same token-gated loopback the tool bridge, dev-channel and
 * todo-sync use — POST to the substrate's in-process reply sink (`SINK_PORT` +
 * `/activity`). This is a DIFFERENT process from the gateway and shares no
 * memory with it, so the sink is the only seam; never a direct DB or store open
 * here (and there is no DB anyway — the inspector buffer is live-only, in memory).
 *
 * Env (baked into the hook command by `build-settings.ts` at spawn time):
 *   SINK_PORT   — the substrate's reply-sink loopback port
 *   SINK_TOKEN  — shared secret for sink POSTs (X-Sink-Token)
 *   SESSION_ID  — the substrate's `--session-id` (the sink's session key), taken
 *                 from env not stdin so it always matches the sink registration
 *   TAP_PHASE   — `pre` | `post`
 *
 * FAIL-SOFT: any missing env / bad input / transport error exits 0 silently. An
 * inspector tap must NEVER perturb the agent's turn — the panel going blind is
 * strictly better than a broken turn.
 */

interface HookInput {
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

/** Max chars of tool detail forwarded. The inspector is a live glance, not a log;
 *  a 40 KB file write must not become a 40 KB WS frame fanned to every client. */
const DETAIL_MAX = 160

/**
 * One-line human summary of a tool call, from the fields that actually identify
 * WHICH call it is. Ordered by how the owner thinks about it: a path for file
 * tools, the command for Bash, the pattern for search tools, the URL for fetches,
 * the prompt for a subagent. Falls back to '' rather than dumping raw JSON —
 * unknown args are frequently large and occasionally sensitive, and a bare tool
 * name is still a useful tick.
 *
 * Exported for direct unit testing (the redaction + truncation guarantees below
 * are the load-bearing part, so they get asserted without spawning a subprocess).
 */
export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (input === undefined || input === null) return ''
  const pick = (k: string): string | undefined => {
    const v = input[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const raw =
    pick('file_path') ??
    pick('path') ??
    pick('command') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('description') ??
    pick('prompt') ??
    ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

async function main(): Promise<void> {
  const port = process.env['SINK_PORT']
  const token = process.env['SINK_TOKEN']
  const sessionId = process.env['SESSION_ID']
  const phase = process.env['TAP_PHASE']
  // Not wired for this REPL (or a bare-hook test env) → nothing to do.
  if (!port || !token || !sessionId) {
    process.exit(0)
  }
  if (phase !== 'pre' && phase !== 'post') {
    process.exit(0)
  }

  let input: HookInput = {}
  try {
    const raw = await Bun.stdin.text()
    if (raw.trim()) input = JSON.parse(raw) as HookInput
  } catch {
    process.exit(0)
  }

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  if (toolName === '') {
    process.exit(0)
  }

  try {
    await fetch(`http://127.0.0.1:${port}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Sink-Token': token },
      body: JSON.stringify({
        session_id: sessionId,
        phase,
        tool_name: toolName,
        detail: summarizeToolInput(input.tool_input),
      }),
    })
  } catch {
    // best-effort — the inspector tap is not allowed to affect the agent turn
  }
  process.exit(0)
}

// Only run as a hook subprocess, not when imported by a unit test for
// `summarizeToolInput` (mirrors the guard shape used by the other hooks' tests,
// which spawn the file rather than import it).
if (import.meta.main) {
  main().catch(() => process.exit(0))
}
