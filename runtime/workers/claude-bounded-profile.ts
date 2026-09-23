import { createHash } from 'node:crypto'

/** Native child definition, supplied by the host through --agents. An explicit
 * allowlist excludes the owner's MCP tools from each bounded call's schema pool.
 * This is a context surface, not a filesystem/network sandbox: Bash still runs
 * commands, and the request's grants and result-file contract remain in force. */
export const CLAUDE_BOUNDED_AGENT = 'neutron-bounded-worker'
export const CLAUDE_BOUNDED_AGENTS = {
  [CLAUDE_BOUNDED_AGENT]: {
    description: 'Execute one host-dispatched bounded build, plan, or review task.',
    prompt: 'Follow the host request and brief. Honor its tool, write and network limits. Report only through the requested result file; return blocked when unable to proceed.',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
  },
}
export const CLAUDE_BOUNDED_AGENTS_JSON = JSON.stringify(CLAUDE_BOUNDED_AGENTS)
/** Persist the exact spawn definition, not an asserted version or caller intent. */
export const CLAUDE_BOUNDED_PROFILE_FINGERPRINT = createHash('sha256').update(CLAUDE_BOUNDED_AGENTS_JSON).digest('hex')
