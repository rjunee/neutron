/** Claude Code's native tool for creating a subagent from an existing REPL.
 *
 * ITS OWN MODULE so the gateway's grant list can name the tool without importing
 * the worker implementation — `claude-in-repl.ts` pulls in `node:fs/promises`
 * and `node:crypto`, which is a heavy dependency to acquire for one string.
 *
 * ONE DEFINITION, because the dispatch prompt and the REPL's granted `--tools`
 * surface must name the same tool and for a night they did not. Claude Code
 * 2.1.273 (installed 2026-09-16 20:32) renamed `Task` to `Agent`; the grant list
 * kept saying `Task`, and every dispatch was answered `No such tool available:
 * Agent. Agent is disabled for this session`. No trident worker could be created
 * between that upgrade and the fix, and it surfaced only as a dispatch timeout.
 *
 * Gateway depends on runtime and never the reverse, which is why this lives here. */
export const SUBAGENT_TOOL_NAME = 'Agent'
