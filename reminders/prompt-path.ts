/**
 * @neutronai/reminders — absolute path to the shipped ritual-executor system
 * prompt (plan task 4).
 *
 * `reminders/ritual-agent-base.md` is a static package asset threaded to the
 * spawned ritual REPL as `--append-system-prompt-file` so a scheduled ritual
 * runs as an UNATTENDED executor rather than the interactive chat persona
 * (`repl-agent-base.md`). Resolved by module-dir (the same `dirname(fileURLToPath(
 * import.meta.url))` pattern the substrate uses for `DEFAULT_AGENT_BASE_PROMPT`
 * at `runtime/adapters/claude-code/persistent/signatures.ts:40`), so it points at
 * the file inside the installed package regardless of cwd.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path to the shipped ritual-executor system prompt. */
export const RITUAL_AGENT_BASE_PROMPT: string = join(HERE, 'ritual-agent-base.md')
