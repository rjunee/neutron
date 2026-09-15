/** The provider vocabulary shared by project storage, conversational selection, and bounded work. */
export const PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'pi'] as const

export type Provider = (typeof PROVIDERS)[number]
