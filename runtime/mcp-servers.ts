/**
 * @neutronai/runtime — OWNER-INSTALLED MCP servers: the shape, the rules, the grant.
 *
 * Until this module existed the spawned agent's session got exactly ONE MCP server
 * beyond its own plumbing — the in-process Neutron tool bridge — and there was no
 * way for the owner to add another (`persistent/spawn.ts` built the whole
 * `mcpServers` object from two compiled-in entries). Everything the wider MCP
 * ecosystem publishes was therefore unreachable, which is a parity gap against any
 * agent harness the owner might otherwise run.
 *
 * This file owns the parts that must NOT be duplicated anywhere:
 *
 *   1. {@link OwnerMcpServerSpec} — what an installed server IS: a name, a command,
 *      its args, and the NAMES of the environment variables it receives. Values are
 *      deliberately not part of the spec; they live encrypted (see the store).
 *   2. {@link parseOwnerMcpServerInput} — the ONE validator. A settings surface is a
 *      trust boundary and this is where it is enforced, so a caller cannot construct
 *      a spec that skipped a check.
 *   3. {@link computeMcpServerGrantHash} — what the owner's approval is BOUND to.
 *   4. {@link renderMcpServerGrant} — the prompt text, rendered from the spec by
 *      code, so what is displayed cannot drift from what is granted.
 *   5. {@link mcpSurfaceFingerprint} — the warm-session identity of the installed
 *      set, so a config change reaches the next turn (see § REUSE below).
 *
 * ── AN INSTALLED SERVER IS A SUBPROCESS, SO APPROVAL IS THE WHOLE FEATURE ────
 * Adding a server means the agent can start a program on this box with the owner's
 * permissions. There is no sandbox underneath it and no second gate: the owner IS
 * the security boundary. Two consequences drive the design:
 *
 *   - The grant hash covers the command, EVERY arg (positionally — an arg is not a
 *     set), and the env-var names (sorted — order is meaningless). Change any of
 *     them and the hash changes, so the old approval no longer matches and the
 *     server is not wired until the owner approves the new one. A program cannot
 *     widen what it runs after being approved. This is the same content-hash
 *     binding `reminders/ritual-approval.ts` uses for scheduled executors, for the
 *     same reason and deliberately not a second mechanism.
 *
 *   - {@link renderMcpServerGrant} names the command, the args and the env-var
 *     NAMES — never a value. A prompt that overstates or understates what it grants
 *     is worse than no gate at all: this repo shipped exactly that failure once, an
 *     approval for network egress a capability could not even exercise
 *     (`docs/as-built/2026-08-09-live-agent-web-tools.md`). So the prompt is built
 *     from the same fields the hash covers, and the test suite asserts the pairing
 *     rather than the wording.
 *
 * ── WHY THE VALUES ARE NOT IN THE SPEC ──────────────────────────────────────
 * An env value is a secret (an API token, usually). Keeping it out of the spec is
 * what lets the spec be stored in plain `instance_metadata`, returned to both
 * clients, rendered in an approval prompt and written to a log without any of those
 * becoming a place a secret leaks. The values go to the AES-256-GCM credential
 * store; only the spawn path ever holds them, and only in a 0600 file it deletes.
 *
 * ── § REUSE: WHY A FINGERPRINT AND NOT A FLAG ───────────────────────────────
 * The set of MCP servers is a SPAWN-TIME property of a `claude` child — the config
 * is read once, at startup, from `--mcp-config`. A warm REPL therefore cannot learn
 * about a server added after it started. The persistent pool already solves this
 * class of problem for the tool surface and for a rotated credential: it compares
 * the live request against the warm child's and evicts + respawns (resuming the
 * transcript) when they differ. {@link mcpSurfaceFingerprint} makes the installed
 * set comparable the same way.
 *
 * It is a FINGERPRINT rather than a version counter or a dirty flag on purpose:
 * equal configuration must produce an equal value, or every turn would evict the
 * child and the owner would pay a cold spawn per message. Sorted by name, with args
 * kept positional; env VALUES are hashed in (never stored or logged) so rotating a
 * secret actually reaches the subprocess instead of leaving the old value live
 * until something else happens to respawn.
 */

import { createHash } from 'node:crypto'

/** Longest accepted server name. Also the `mcp__<name>` tool namespace. */
export const MCP_SERVER_NAME_MAX = 32
/** Longest accepted command string. */
export const MCP_SERVER_COMMAND_MAX = 512
/** Most args one server may declare. */
export const MCP_SERVER_ARGS_MAX = 32
/** Longest accepted single arg. */
export const MCP_SERVER_ARG_MAX = 1024
/** Most env vars one server may declare. */
export const MCP_SERVER_ENV_MAX = 32
/** Longest accepted env-var name. */
export const MCP_SERVER_ENV_NAME_MAX = 64
/** Longest accepted env-var value. */
export const MCP_SERVER_ENV_VALUE_MAX = 4096
/**
 * Longest accepted TOTAL env payload, measured on the exact JSON the store writes.
 *
 * The per-value cap alone is not enough: the values are persisted as ONE
 * `JSON.stringify(env)` credential token, and `ProjectCredentialStore` refuses a
 * token over 8192 bytes. Two max-length values each pass the per-value check and
 * then blow that cap SERVER-SIDE, which surfaced as a 500 instead of a validation
 * message the owner could act on. Validating the aggregate here — against the same
 * string the store will write — is what makes the refusal a complaint rather than an
 * error. Kept BELOW the store's cap rather than equal to it so the two limits cannot
 * be off by one; `gateway/__tests__/mcp-servers-store.test.ts` pins the ordering so a
 * future change to either one cannot silently re-open the gap.
 */
export const MCP_SERVER_ENV_TOTAL_MAX = 8000
/** Most servers one instance may install. */
export const MCP_SERVERS_MAX = 24

/**
 * A legal server name: lowercase, starts alphanumeric, `[a-z0-9-]` after.
 *
 * Tight because the name is not just a label — it becomes an `mcpServers` JSON key,
 * an `mcp__<name>` permission token in a comma-joined `--allowedTools` value, and
 * part of a `project_credentials.service` key (which is itself `[a-z0-9_.-]` only).
 * A name that needed quoting or escaping in any one of those would be a defect
 * looking for a place to happen, so the charset is the intersection of all three.
 */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/** A legal env-var name — the POSIX shape, uppercase. */
export const MCP_SERVER_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

/**
 * Names the owner may NOT take, because the spawn path compiles them in.
 *
 * `neutron` is the in-process tool-bridge server. The dev-channel reply sink is
 * named `neutron-<32 hex>` per session, so the whole `neutron-` prefix is reserved
 * as well — see {@link isReservedMcpServerName}. A collision would not merely be
 * confusing: the merge would either shadow the agent's only way to reply or be
 * silently dropped, and which of those happened would depend on merge order.
 */
export const RESERVED_MCP_SERVER_NAMES: ReadonlyArray<string> = ['neutron']

/** Whether `name` collides with a compiled-in server (exact, or the `neutron-` prefix). */
export function isReservedMcpServerName(name: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.includes(name) || name.startsWith('neutron-')
}

/**
 * Characters refused outright — never stripped — in a command, an arg or an
 * env-var name, so a payload cannot hide from the owner reading the approval
 * prompt: bidi controls (U+202A-U+202E, U+2066-U+2069), zero-width / format
 * characters (U+200B-U+200F, U+FEFF) and C0 controls including tab, newline and
 * carriage return.
 *
 * STRICTER than the ritual prompt's equivalent
 * (`reminders/ritual-registration.ts`), which permits `\t\n\r` because it gates a
 * multi-line prose document. This gates an ARGV. A newline inside a command string
 * has no legitimate meaning and would let the rendered prompt show one thing per
 * line while the exec'd command carried another.
 */
// eslint-disable-next-line no-control-regex
export const MCP_SERVER_BANNED_CHARS_RE =
  /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/**
 * One installed MCP server, as stored and as displayed. Never carries a secret:
 * `env_names` is names only.
 */
export interface OwnerMcpServerSpec {
  name: string
  command: string
  args: readonly string[]
  env_names: readonly string[]
}

/** A spec plus the env VALUES, as handed to the spawn path. Never serialized. */
export interface ResolvedOwnerMcpServer extends OwnerMcpServerSpec {
  env: Readonly<Record<string, string>>
}

/** The outcome of validating owner input: a spec, or every reason it was refused. */
export interface ParsedOwnerMcpServer {
  spec: OwnerMcpServerSpec | null
  /** The env VALUES, keyed by name. Empty when `spec` is null. */
  env: Record<string, string>
  errors: string[]
}

function bannedCharComplaint(field: string, value: string): string | null {
  return MCP_SERVER_BANNED_CHARS_RE.test(value)
    ? `${field} contains a control, zero-width or bidi character`
    : null
}

/**
 * Validate one owner-supplied server definition.
 *
 * REPORTS EVERY PROBLEM, not the first: the owner is present and is the only one
 * who can fix a bad value, and a form that rejects a paste one complaint at a time
 * is a form nobody finishes. Nothing is coerced — a bad value is refused with a
 * reason, because silently "fixing" a command is how an approval prompt ends up
 * describing something other than what runs.
 *
 * Deliberately does NOT check the command EXISTS. A resolvable path proves nothing
 * about the next spawn (the file can appear or vanish between now and then), and
 * probing the filesystem on behalf of a settings write is its own hazard. The spawn
 * either works or the agent reports the server failed to start, which is honest;
 * refusing a command because it is not installed *yet* would block the ordinary
 * "install it in a moment" order of operations.
 */
export function parseOwnerMcpServerInput(raw: unknown): ParsedOwnerMcpServer {
  const errors: string[] = []
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const rawName = typeof input['name'] === 'string' ? input['name'].trim().toLowerCase() : ''
  if (rawName.length === 0) {
    errors.push('name is required')
  } else if (rawName.length > MCP_SERVER_NAME_MAX) {
    errors.push(`name must be at most ${MCP_SERVER_NAME_MAX} characters`)
  } else if (!MCP_SERVER_NAME_RE.test(rawName)) {
    errors.push('name must be lowercase letters, digits and dashes, starting with a letter or digit')
  } else if (isReservedMcpServerName(rawName)) {
    errors.push(`name '${rawName}' is reserved by Neutron's own MCP plumbing`)
  }

  const rawCommand = typeof input['command'] === 'string' ? input['command'].trim() : ''
  if (rawCommand.length === 0) {
    errors.push('command is required')
  } else if (rawCommand.length > MCP_SERVER_COMMAND_MAX) {
    errors.push(`command must be at most ${MCP_SERVER_COMMAND_MAX} characters`)
  } else {
    const complaint = bannedCharComplaint('command', rawCommand)
    if (complaint !== null) errors.push(complaint)
  }

  const args: string[] = []
  const rawArgs = input['args']
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs)) {
      errors.push('args must be an array of strings')
    } else if (rawArgs.length > MCP_SERVER_ARGS_MAX) {
      errors.push(`args must have at most ${MCP_SERVER_ARGS_MAX} entries`)
    } else {
      for (const [i, entry] of rawArgs.entries()) {
        if (typeof entry !== 'string') {
          errors.push(`args[${i}] must be a string`)
          continue
        }
        if (entry.length > MCP_SERVER_ARG_MAX) {
          errors.push(`args[${i}] must be at most ${MCP_SERVER_ARG_MAX} characters`)
          continue
        }
        const complaint = bannedCharComplaint(`args[${i}]`, entry)
        if (complaint !== null) {
          errors.push(complaint)
          continue
        }
        args.push(entry)
      }
    }
  }

  const env: Record<string, string> = {}
  const rawEnv = input['env']
  if (rawEnv !== undefined && rawEnv !== null) {
    if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
      errors.push('env must be an object of NAME to value')
    } else {
      const entries = Object.entries(rawEnv as Record<string, unknown>)
      if (entries.length > MCP_SERVER_ENV_MAX) {
        errors.push(`env must have at most ${MCP_SERVER_ENV_MAX} entries`)
      }
      for (const [key, value] of entries.slice(0, MCP_SERVER_ENV_MAX)) {
        if (key.length > MCP_SERVER_ENV_NAME_MAX || !MCP_SERVER_ENV_NAME_RE.test(key)) {
          // The NAME is echoed because it is not a secret and the owner needs to
          // know which row is wrong. A VALUE is never echoed, here or anywhere.
          errors.push(`env name '${key.slice(0, MCP_SERVER_ENV_NAME_MAX)}' must be A-Z, digits and underscores`)
          continue
        }
        if (typeof value !== 'string' || value.length === 0) {
          errors.push(`env '${key}' must be a non-empty string`)
          continue
        }
        if (value.length > MCP_SERVER_ENV_VALUE_MAX) {
          errors.push(`env '${key}' must be at most ${MCP_SERVER_ENV_VALUE_MAX} characters`)
          continue
        }
        env[key] = value
      }
    }
  }

  // The AGGREGATE, measured on the exact string the credential store will hold. Only
  // worth checking once every individual value has passed, and only when there is
  // something to check — see {@link MCP_SERVER_ENV_TOTAL_MAX}.
  if (errors.length === 0 && Object.keys(env).length > 0) {
    const serialized = JSON.stringify(env).length
    if (serialized > MCP_SERVER_ENV_TOTAL_MAX) {
      // Sizes only. The complaint describes the SHAPE of the problem and never
      // echoes a value, because an error message is a log line waiting to happen.
      errors.push(
        `the environment variables total ${serialized} characters, over the ${MCP_SERVER_ENV_TOTAL_MAX} limit`,
      )
    }
  }

  if (errors.length > 0) return { spec: null, env: {}, errors }
  return {
    spec: { name: rawName, command: rawCommand, args, env_names: Object.keys(env).sort() },
    env,
    errors: [],
  }
}

/**
 * The digest the owner's approval is bound to.
 *
 * A canonical JSON ARRAY, not a joined string, so no field's contents can forge a
 * boundary between fields — the same delimiter-injection reasoning as
 * `computeRitualContentHash`. `args` stays in the owner's order because argv order
 * is semantic; `env_names` is sorted because the set is what matters.
 *
 * ENV VALUES ARE NOT INCLUDED, and that is a decision rather than an oversight:
 * rotating a token must not silently revoke the owner's approval and stop his
 * assistant from working, and re-approving "the same server with a new key" would
 * teach him to click through prompts. What the approval promises is which PROGRAM
 * runs with which VARIABLES SET — and that is exactly what is hashed.
 */
export function computeMcpServerGrantHash(spec: OwnerMcpServerSpec): string {
  const canonical = JSON.stringify([spec.name, spec.command, [...spec.args], [...spec.env_names].sort()])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The approval prompt, rendered from the spec by CODE.
 *
 * Says the four things the grant actually is — the name, the program, its arguments,
 * and the names of the variables it is handed — and then what approving permits. No
 * value appears; the line saying so is part of the promise, because "will it show my
 * API key to whoever is looking at my screen" is the first thing worth answering.
 *
 * ── THE ARGV BOUNDARIES ARE VISIBLE, AND THAT IS THE WHOLE POINT ────────────
 * The program and EACH argument get their own line, the arguments numbered in argv
 * order. An earlier draft joined them with spaces, which made two DIFFERENT grants
 * render identically: `{command:'a b', args:[]}` (run the program literally named
 * `a b`) and `{command:'a', args:['b']}` (run `a` with argument `b`) both printed
 * `a b`. Those hash differently — correctly — so the owner could be shown one thing
 * and be approving another, which is precisely the class of dishonesty this prompt
 * exists to prevent. A rendered prompt must distinguish every pair of specs the
 * grant hash distinguishes, and `runtime/__tests__/mcp-servers.test.ts` asserts that
 * pairing over adversarial pairs rather than over the wording.
 *
 * Each value is wrapped in `⟦…⟧` so leading, trailing and repeated spaces inside a
 * single argument are visible too — a boundary the owner cannot see is a boundary he
 * cannot check.
 *
 * Returned as plain text and displayed verbatim by both clients, so there is no
 * second copy of this wording to drift and no client-side assembly that could show
 * a command different from the hashed one.
 */
export function renderMcpServerGrant(spec: OwnerMcpServerSpec): string {
  const lines = [
    `Install the MCP server "${spec.name}"?`,
    '',
    'Approving lets your assistant start this program on this machine, with your',
    'permissions, and call the tools it offers. It starts exactly this program:',
    '',
    `    program  ⟦${spec.command}⟧`,
    '',
  ]
  if (spec.args.length === 0) {
    lines.push('It is passed no arguments.')
  } else {
    lines.push('and passes it exactly these arguments, in this order:')
    lines.push('')
    for (const [i, arg] of spec.args.entries()) lines.push(`    arg ${i + 1}    ⟦${arg}⟧`)
  }
  lines.push('')
  if (spec.env_names.length === 0) {
    lines.push('It receives no environment variables.')
  } else {
    lines.push('It receives these environment variables (names shown, values never):')
    lines.push('')
    for (const name of spec.env_names) lines.push(`    ${name}`)
  }
  lines.push('')
  lines.push(`Its tools become callable as mcp__${spec.name}. Changing the command, the`)
  lines.push('arguments or the variable names asks you again, and removing the server')
  lines.push('revokes this approval — reinstalling it asks you again too.')
  return lines.join('\n')
}

/**
 * The warm-session identity of an installed set — see § REUSE in the file header.
 *
 * 16 hex chars of SHA-256, matching `authFingerprintFor`'s shape for the same job.
 * Equal configuration MUST yield an equal value or the pool thrashes, so the input
 * is canonicalised: sorted by name, args positional, env sorted by name.
 *
 * Env VALUES are hashed in. A rotated secret has to reach the subprocess, and the
 * only way a running child picks up a new value is a respawn — so the value has to
 * be part of what "the same surface" means. The digest is held in memory for the
 * life of the session and never persisted or logged.
 */
export function mcpSurfaceFingerprint(servers: ReadonlyArray<ResolvedOwnerMcpServer>): string {
  if (servers.length === 0) return ''
  const canonical = JSON.stringify(
    [...servers]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((s) => [
        s.name,
        s.command,
        [...s.args],
        Object.entries(s.env)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, v]),
      ]),
  )
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}
