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
  /**
   * The tool's RETURN VALUE. Present on `PostToolUse` only (CC's payload is
   * `{ session_id, tool_name, tool_input, tool_response, cwd, ... }` — see
   * `todo-sync.ts`). The first build of this hook never read this field, which is
   * why the panel could say `tasks_list` finished but never a word about what it
   * returned. Ryan 2026-07-30: the panel should read like a Claude Code session,
   * and half of a session transcript is tool OUTPUT.
   */
  tool_response?: unknown
}

/** Max chars of the one-line summary. The row's collapsed form. */
const DETAIL_MAX = 160

/**
 * Max chars of the FULL argument / result payloads forwarded for the expanded view.
 * Mirrors `BODY_MAX` in `open/activity-inspector.ts` (which clips again on the
 * recording side — this is the transport-side ceiling so an oversized payload never
 * crosses the loopback at all). The inspector is a live glance, not a log: a 40 KB
 * file read must not become a 40 KB WS frame fanned to every client.
 */
const BODY_MAX = 2_000

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * One-line human summary of a tool call, from the fields that actually identify
 * WHICH call it is. Ordered by how the owner thinks about it: a path for file
 * tools, the command for Bash, the pattern for search tools, the URL for fetches,
 * the prompt for a subagent.
 *
 * TOTAL, deliberately. This used to return '' for a tool whose arguments matched
 * none of those keys, on the reasoning that unknown args "are frequently large and
 * occasionally sensitive". Large is handled by the cap; sensitive is not a hazard
 * worth a blank row here, because this payload's only destination is the OWNER's
 * own authenticated panel showing the owner's own session — the same content chat
 * already renders to him. The blank, meanwhile, was a real cost: every MCP tool
 * whose argument key is not in that list rendered as a bare name with no hint of
 * what it was called with. So the fallback is now a compact `key=value` render.
 *
 * Exported for direct unit testing (the truncation guarantees are load-bearing, so
 * they get asserted without spawning a subprocess).
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
    // `text` is the dev-channel `reply` tool's argument — i.e. the agent's entire
    // message to the owner. Its absence from this list is why the screenshot's
    // assistant turn rendered as a bare unreadable id with no content at all.
    pick('text') ??
    compactArgs(input)
  return clip(raw.replace(/\s+/g, ' ').trim(), DETAIL_MAX)
}

/** `a=1 b=hello` for an argument object with no recognised identifying key. */
function compactArgs(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue
    const rendered =
      typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${rendered}`)
    if (parts.join(' ').length > DETAIL_MAX) break
  }
  return parts.join(' ')
}

/**
 * The FULL arguments, pretty-printed for the expanded view. Newlines preserved —
 * a multi-line `command` or `prompt` is far easier to read shaped than flattened.
 */
export function renderToolArgs(input: Record<string, unknown> | undefined): string {
  if (input === undefined || input === null) return ''
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  // A single string argument is its own best rendering — `command` for Bash is the
  // shell line, and wrapping it in JSON quoting only makes it harder to read.
  const only = keys[0]
  if (keys.length === 1 && only !== undefined && typeof input[only] === 'string') {
    return clip(input[only] as string, BODY_MAX)
  }
  try {
    return clip(JSON.stringify(input, null, 2), BODY_MAX)
  } catch {
    // Circular / non-serialisable args are not worth failing a row over.
    return clip(compactArgs(input), BODY_MAX)
  }
}

/**
 * The tool's OUTPUT, rendered for the expanded view.
 *
 * CC's `tool_response` has no single shape — it is whatever the tool returned. The
 * forms that actually occur, handled in order:
 *   - a plain string (many MCP tools),
 *   - `{ content: [{ type: 'text', text }] }` (the MCP content-block form),
 *   - `{ stdout, stderr }` (Bash),
 *   - `{ file: { content } }` (Read),
 *   - anything else ⇒ pretty JSON.
 * Unknown shapes fall through to JSON rather than to '' — an unfamiliar object is
 * still the answer to "what did it return?", and guessing wrong here costs nothing
 * while showing nothing costs the whole feature.
 */
export function renderToolResult(response: unknown): string {
  if (response === undefined || response === null) return ''
  if (typeof response === 'string') return clip(response, BODY_MAX)
  if (typeof response !== 'object') return clip(String(response), BODY_MAX)

  const r = response as Record<string, unknown>

  const content = r['content']
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        if (typeof b === 'string') return b
        if (typeof b === 'object' && b !== null) {
          const t = (b as Record<string, unknown>)['text']
          if (typeof t === 'string') return t
        }
        return ''
      })
      .filter((s) => s !== '')
      .join('\n')
    if (text !== '') return clip(text, BODY_MAX)
  }

  const stdout = typeof r['stdout'] === 'string' ? (r['stdout'] as string) : ''
  const stderr = typeof r['stderr'] === 'string' ? (r['stderr'] as string) : ''
  if (stdout !== '' || stderr !== '') {
    return clip([stdout, stderr].filter((s) => s !== '').join('\n'), BODY_MAX)
  }

  const file = r['file']
  if (typeof file === 'object' && file !== null) {
    const fc = (file as Record<string, unknown>)['content']
    if (typeof fc === 'string' && fc !== '') return clip(fc, BODY_MAX)
  }

  try {
    return clip(JSON.stringify(response, null, 2), BODY_MAX)
  } catch {
    return ''
  }
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
        // The expanded view's content. `args` on both phases (a `post` row still
        // wants to say WHICH call finished); `result` only where it exists.
        args: renderToolArgs(input.tool_input),
        ...(phase === 'post' ? { result: renderToolResult(input.tool_response) } : {}),
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
