#!/usr/bin/env bun
/**
 * PostToolUse hook (matcher: `TodoWrite`) for Neutron persistent-REPL sessions.
 *
 * SIBLING of `enforce-reply.ts` (the Stop hook): a small `bun`-run subprocess CC
 * invokes, reading a structured JSON payload on stdin and doing one thing. Where
 * enforce-reply BLOCKS a turn, this hook is NOTIFY-ONLY — it never blocks or
 * mutates the tool call; it forwards the agent's `TodoWrite` list to the gateway
 * so multi-step work shows up on the Work Board automatically.
 *
 * CC fires this AFTER a `TodoWrite` tool call succeeds. Hook stdin (the CC
 * PostToolUse payload) carries `{ session_id, tool_name, tool_input, tool_response,
 * cwd, ... }`; `tool_input.todos` is the `TodoWriteInput.todos[]` array
 * (`{ content, status: 'pending'|'in_progress'|'completed', activeForm }`).
 *
 * TRANSPORT: the same loopback the tool-bridge + dev-channel use — a token-gated
 * POST to the substrate's in-process reply sink (`SINK_PORT` + `/todo-sync`). The
 * sink resolves the session's active project scope and reconciles the list into
 * the shared `WorkBoardStore` (one `onChange` live-push). This subprocess is a
 * DIFFERENT process from the gateway and shares no memory with it, so the sink is
 * the seam — never a direct DB open here.
 *
 * Env (baked into the hook command by `build-settings.ts` at spawn time):
 *   SINK_PORT   — the substrate's reply-sink loopback port
 *   SINK_TOKEN  — shared secret for sink POSTs (X-Sink-Token)
 *   SESSION_ID  — the substrate's `--session-id` (the sink's session key). Taken
 *                 from env, not stdin, so it is guaranteed to match the sink's
 *                 registration regardless of CC's stdin `session_id`.
 *
 * FAIL-SOFT: any missing env / bad input / transport error exits 0 silently — a
 * board-sync failure must NEVER perturb the agent's turn.
 */

interface HookInput {
  session_id?: string
  tool_name?: string
  tool_input?: { todos?: unknown }
}

async function main(): Promise<void> {
  const port = process.env['SINK_PORT']
  const token = process.env['SINK_TOKEN']
  const sessionId = process.env['SESSION_ID']
  // Not wired for this REPL (or a bare-hook test env) → nothing to do.
  if (!port || !token || !sessionId) {
    process.exit(0)
  }

  let input: HookInput = {}
  try {
    const raw = await Bun.stdin.text()
    if (raw.trim()) input = JSON.parse(raw) as HookInput
  } catch {
    process.exit(0)
  }

  // The matcher already scopes this to TodoWrite, but double-check defensively so
  // a broadened matcher (or a hand-invoked hook) can't forward a foreign payload.
  if (input.tool_name !== undefined && input.tool_name !== 'TodoWrite') {
    process.exit(0)
  }

  const todos = input.tool_input?.todos
  if (!Array.isArray(todos)) {
    process.exit(0)
  }

  try {
    await fetch(`http://127.0.0.1:${port}/todo-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Sink-Token': token },
      body: JSON.stringify({ session_id: sessionId, todos }),
    })
  } catch {
    // best-effort — the board sync is not allowed to affect the agent turn
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
