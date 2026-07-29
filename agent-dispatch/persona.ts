/**
 * @neutronai/agent-dispatch — default persona loader.
 *
 * Bridges the dispatch service's injectable `PersonaLoader` to the trident
 * persona-prompt loader (`trident/agent-prompts.ts:loadAgentSystemPrompt`),
 * which reads the lifted `prompts/{atlas,sentinel}.md` files through the
 * path-traversal-safe `@neutronai/prompts` reader and falls back to a terse
 * inline identity if a file is missing. This is the ONLY module-level link to
 * trident, and it lives here (not in `service.ts`) so the service stays
 * trident-agnostic + unit-testable with a stub loader.
 */

import { loadAgentSystemPrompt } from '@neutronai/trident/agent-prompts.ts'
import type { PersonaLoader } from './service.ts'

/** The production persona loader — reads `prompts/<kind>.md`. */
export const defaultPersonaLoader: PersonaLoader = (kind) => {
  const loaded = loadAgentSystemPrompt(kind)
  return { content: loaded.content, source: loaded.source }
}
