/**
 * @neutronai/gateway/realmode-composer — per-instance `.env` overlay loader.
 *
 * S13 (2026-05-16) — Codex P1 fix on PR #124.
 *
 * Why this exists: systemd's `EnvironmentFile=-{{OWNER_HOME}}/.env`
 * directive reads the `.env` file EXACTLY ONCE, at unit start. Any
 * variables written to that file AFTER the gateway process is already
 * running (the synthetic-auth provisioning race; a manual operator
 * `.env` edit; a Max-OAuth-attach flow that writes the token to disk
 * mid-session) are invisible to `process.env` until `systemctl restart`
 * re-execs the unit.
 *
 * The S13 substrate-resolver fix (lazy `resolvePool`) re-runs
 * `resolveLlmCredentials` on every import dispatch — but if the
 * resolver only inspects `process.env`, that boot-time snapshot stays
 * stale and the lazy retry-at-dispatch path picks up nothing new. This
 * loader closes that gap: on every dispatch we re-parse the on-disk
 * `.env` file, layer it on top of `process.env`, and hand the merged
 * map to the resolver as the `env` argument.
 *
 * Format compatibility. systemd `EnvironmentFile` accepts a narrow
 * subset of the dotenv conventions:
 *   - `KEY=VALUE` (no whitespace around `=`)
 *   - empty lines + lines beginning with `#` are ignored
 *   - leading whitespace on a line is stripped
 *   - values may be wrapped in single or double quotes (stripped on parse)
 *   - escape sequences inside double-quoted values are NOT expanded
 *     (this matches systemd's own EnvironmentFile parser; keep the
 *     overlay deterministic with that)
 *
 * The synthetic-auth + manual operator writers we target produce the
 * shape above. We don't aim for full dotenv-spec compliance — that
 * would diverge from systemd and create surprising precedence between
 * the unit's boot-time env and a re-read overlay.
 *
 * Failure handling: missing file, read errors, parse errors → return an
 * empty overlay (the resolver falls through to `process.env` only,
 * matching the boot-time-only behaviour). Never throws — a corrupted
 * `.env` should not crash the runner. A `console.warn` line surfaces
 * the failure so operators see it in journald.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cap the .env file size we'll parse. The synthetic-auth + operator
 * writers produce files in the few-hundred-bytes range; a 64KB cap is
 * orders of magnitude above any legitimate `.env` while still bounding
 * pathological cases (operator dumps a huge file, fs gets corrupted,
 * etc.) so we never block the dispatch on a slow parse.
 */
const MAX_ENV_FILE_BYTES = 64 * 1024

/**
 * Load a per-instance `.env` overlay map. Returns `{}` when the file is
 * absent, unreadable, or exceeds the size cap. Never throws.
 *
 * The returned map is intended to be SPREAD ON TOP of `process.env`
 * (the call site does `{...process.env, ...overlay}`) so a fresh value
 * in the on-disk `.env` overrides a stale boot-time `process.env` entry
 * with the SAME key. Keys present only in `process.env` are preserved.
 *
 * Exported for unit testing; the production composer wires this into
 * the lazy `resolvePool` closure in `gateway/index.ts`.
 */
export function loadInstanceEnvOverlay(owner_home: string): Record<string, string> {
  if (typeof owner_home !== 'string' || owner_home.length === 0) return {}
  const path = join(owner_home, '.env')
  if (!existsSync(path)) return {}
  let body: string
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return {}
    if (stat.size > MAX_ENV_FILE_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[composer] project env overlay at ${path} exceeds ${MAX_ENV_FILE_BYTES}B (got ${stat.size}B) — skipping`,
      )
      return {}
    }
    body = readFileSync(path, 'utf8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[composer] project env overlay read failed at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
  return parseEnvFileBody(body)
}

/**
 * Parse a `.env` body string into a `KEY → VALUE` map using systemd
 * EnvironmentFile semantics. See file header for the grammar.
 *
 * Exported for unit testing — the parse logic is deterministic and
 * worth pinning independently of the FS layer.
 */
export function parseEnvFileBody(body: string): Record<string, string> {
  const overlay: Record<string, string> = {}
  // Normalise CRLF / CR-only to LF before splitting so we don't end up
  // with stray `\r` characters appended to the last token on a line.
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    // Optional `export ` prefix (systemd accepts but ignores it; some
    // operators write it so the file double-serves as a shell-sourceable
    // script).
    const declaration = line.startsWith('export ')
      ? line.slice('export '.length).trimStart()
      : line
    const eqIdx = declaration.indexOf('=')
    if (eqIdx <= 0) continue // no `=` OR `=` at position 0 (empty key) → skip
    const key = declaration.slice(0, eqIdx).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = declaration.slice(eqIdx + 1)
    // Strip surrounding ASCII quotes if present and balanced.
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    overlay[key] = value
  }
  return overlay
}
