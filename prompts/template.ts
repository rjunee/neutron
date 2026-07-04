/**
 * @neutronai/prompts — template substitution runtime.
 *
 * The lifted Nova prompt files contain `{{KEY}}` template variables (e.g.
 * `{{OWNER_HOME}}`) wherever a hardcoded path or owner-scoped value would
 * otherwise be baked in. This module is the only authoritative reader: it
 * loads a prompt file by name from the package directory and substitutes
 * every template variable strictly — any unresolved `{{KEY}}` left behind
 * after substitution throws a `TemplateError`.
 *
 * C4-a2 (SD1, execution brief § 2.3): the canonical home token is
 * `{{OWNER_HOME}}` — the only home token. No back-compat home alias exists.
 *
 * Strict resolution prevents two failure modes:
 *
 *   1. A typo'd variable name (e.g. `{{OWNER_HONE}}`) silently shipping a
 *      malformed prompt to a downstream agent.
 *   2. A new platform-level path getting added to a prompt without the
 *      caller schema being updated to provide a value.
 *
 * Cross-refs:
 *  - docs/plans/P0-system-user-data-separation.md § 1.2 (prompts module spec)
 *  - docs/engineering-plan.md § B.P0 + § A.3.3 (system-vs-owner separation)
 *  - prompts/<name>.md header blocks (per-prompt lift provenance)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Matches a single template token of the form `{{NAME}}` where `NAME` is an
 * uppercase identifier (`A-Z`, `0-9`, `_`) starting with a letter or
 * underscore. Lowercase / mixed-case tokens are NOT treated as templates so
 * the prompts can still contain incidental `{{...}}` text without colliding
 * (none currently do, but future-proof).
 */
const TEMPLATE_TOKEN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g

/**
 * Thrown when `substituteTemplate` or `loadPrompt` encounters one or more
 * `{{KEY}}` tokens with no corresponding entry in the supplied `vars` map.
 * `missingKeys` is sorted + deduped so error output is stable across runs
 * (test fixtures can pin against it).
 */
export class TemplateError extends Error {
  readonly missingKeys: ReadonlyArray<string>
  constructor(missingKeys: ReadonlyArray<string>, message: string) {
    super(message)
    this.name = 'TemplateError'
    this.missingKeys = missingKeys
  }
}

/** Canonical per-owner home token (C4-a2, SD1). */
export const OWNER_HOME_KEY = 'OWNER_HOME'

/** Canonical owner Telegram chat-id token. Prompts that post to Telegram
 *  carry `{{TELEGRAM_CHAT_ID}}` rather than a baked-in chat id so the public
 *  repo ships NO real chat id — the value is resolved from owner config at
 *  substitution time (see `buildPromptVars`). */
export const TELEGRAM_CHAT_ID_KEY = 'TELEGRAM_CHAT_ID'

/** Clear, greppable placeholder substituted for `{{TELEGRAM_CHAT_ID}}` when
 *  no owner chat id is configured (env `TELEGRAM_CHAT_ID` unset). Intentionally
 *  obvious so an unconfigured deployment surfaces the gap instead of silently
 *  resolving to some real chat. */
export const TELEGRAM_CHAT_ID_PLACEHOLDER = '<telegram-chat-id-unset>'

/**
 * Build the standard template-variable map from owner config (the process
 * environment, which Bun populates from the instance `.env`). This is the
 * single owner-config → vars path every prompt substitution funnels through,
 * so a new platform-level token is wired in exactly once here rather than at
 * each call site:
 *
 *  - `{{OWNER_HOME}}`       ← `env.OWNER_HOME` (the per-instance data dir).
 *  - `{{TELEGRAM_CHAT_ID}}` ← `env.TELEGRAM_CHAT_ID`, falling back to
 *    `TELEGRAM_CHAT_ID_PLACEHOLDER` when unset so a bare checkout carries no
 *    real chat id.
 *
 * Callers pass the result straight to `substituteTemplate` / `loadPrompt`.
 */
export function buildPromptVars(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { OWNER_HOME: string; TELEGRAM_CHAT_ID: string } {
  const ownerHome = env[OWNER_HOME_KEY]
  const chatId = env[TELEGRAM_CHAT_ID_KEY]
  return {
    OWNER_HOME: typeof ownerHome === 'string' ? ownerHome : '',
    TELEGRAM_CHAT_ID:
      typeof chatId === 'string' && chatId.length > 0
        ? chatId
        : TELEGRAM_CHAT_ID_PLACEHOLDER,
  }
}

/**
 * Replace every `{{KEY}}` in `content` with `vars[KEY]`. Extra entries in
 * `vars` that do not appear in `content` are ignored — this lets a single
 * caller pass a shared variable set across many prompts. Any `{{KEY}}` in
 * `content` without a matching entry in `vars` throws a `TemplateError`
 * with the full sorted list of missing keys (one error covers all misses,
 * not one error per miss).
 */
export function substituteTemplate(
  content: string,
  vars: Readonly<Record<string, string>>,
): string {
  const missing = new Set<string>()
  const result = content.replace(TEMPLATE_TOKEN, (match: string, rawKey: string) => {
    const value = vars[rawKey]
    if (value === undefined) {
      missing.add(rawKey)
      return match
    }
    return value
  })
  if (missing.size > 0) {
    const sorted = [...missing].sort()
    throw new TemplateError(
      sorted,
      `Unresolved template keys: ${sorted.map((k) => `{{${k}}}`).join(', ')}`,
    )
  }
  return result
}

/**
 * Sorted list of every prompt the @neutronai/prompts package ships. Callers
 * that want to enumerate or pre-validate the entire library iterate this
 * (e.g. the test suite verifies every entry resolves cleanly with synthetic
 * vars). Adding a new lifted prompt to `prompts/<name>.md` REQUIRES adding
 * the filename here — the test suite will fail until the array stays in
 * sync with the directory contents.
 */
export const KNOWN_PROMPTS = [
  'argus.md',
  'atlas.md',
  'forge.md',
  'reminder-agent-base.md',
  'reminder-patterns.md',
  'scribe.md',
  'sentinel.md',
] as const

export type KnownPromptName = (typeof KNOWN_PROMPTS)[number]

/**
 * Match a prompt-file basename: lowercase letters / digits / hyphens, ending
 * in `.md`. Locked deliberately tight — every entry in `KNOWN_PROMPTS`
 * conforms, future entries should too, and the strictness is the
 * path-traversal defence (see `loadPrompt` below).
 */
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]*\.md$/

/**
 * Load a `.md` prompt from this package's directory and substitute its
 * template variables. The file path is resolved relative to the on-disk
 * location of `template.ts` (via `import.meta.url`), NOT the caller's cwd —
 * downstream packages can call `loadPrompt` from any working directory and
 * still hit the lifted file.
 *
 * `name` must be a bare `.md` filename matching `PROMPT_NAME` (no path
 * separators, no `..`, no leading dot). The strict check defends against
 * accidental or hostile traversal — `loadPrompt('../package.json', ...)`
 * would otherwise read arbitrary files under the package root. Even though
 * P0 has no untrusted callers yet, locking the contract now is cheap; once
 * Cores or user input feed prompt names in P1+, the validation is
 * already in place.
 *
 * Throws `TemplateError` on any unresolved variable. Throws a plain `Error`
 * if `name` fails the bare-filename check. Throws the underlying filesystem
 * error (typically `ENOENT`) if `name` passes the check but does not match
 * a real file in `prompts/`.
 */
export function loadPrompt(name: string, vars: Readonly<Record<string, string>>): string {
  if (!PROMPT_NAME.test(name)) {
    throw new Error(
      `loadPrompt: invalid prompt name ${JSON.stringify(name)}; expected a bare \`.md\` filename like \`atlas.md\` (no path separators, no \`..\`)`,
    )
  }
  const filePath = join(HERE, name)
  const content = readFileSync(filePath, 'utf8')
  return substituteTemplate(content, vars)
}
