/**
 * @neutronai/prompts — public barrel.
 *
 * Lifted-and-parameterized copies of Nova's canonical agent prompt library
 * (Atlas, Argus, Sentinel, Forge, Scribe, reminder-agent-base,
 * reminder-patterns) plus the strict template-substitution
 * runtime that resolves `{{OWNER_HOME}}` and any future platform-level
 * template variables. See `template.ts` for the resolver contract and the
 * per-file `<!-- LIFTED FROM: ... -->` headers for source provenance.
 */

export const __MODULE__ = '@neutronai/prompts' as const

export {
  KNOWN_PROMPTS,
  OWNER_HOME_KEY,
  TELEGRAM_CHAT_ID_KEY,
  TELEGRAM_CHAT_ID_PLACEHOLDER,
  TemplateError,
  buildPromptVars,
  loadPrompt,
  substituteTemplate,
} from './template.ts'
export type { KnownPromptName } from './template.ts'
