/**
 * @neutronai/codegen-core — tool-call dispatch handlers + tool definitions.
 *
 * Six handlers (read / write / edit / bash / grep / glob), all scoped
 * to the per-project worktree. Any file-path argument is resolved
 * relative to `ctx.worktree_path` and rejected with an `is_error`
 * tool_result if the resolved path escapes the worktree (`..`).
 *
 * Argus sub-agents get a narrower surface: `read` + `bash`. The bash
 * handler's `allowlist` parameter enforces a regex prefix check on the
 * `command` arg — when non-null, any command not matching one of the
 * permitted prefixes (`git show` / `git log` / `git diff` / `bun test`
 * / `bunx tsc` / `rg` / `cat` / `ls` / `pwd` by default) returns
 * `is_error: true`.
 *
 * Uses Node + Bun stdlib only (`node:fs/promises`, `node:path`,
 * `Bun.spawn`, `Bun.glob`). Per the architecture invariant in
 * `docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md`
 * § "Architecture (the layer cake)", this Core does NOT import the
 * Anthropic SDK package. The production-composer lint test enforces it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'

import type {
  CodegenToolContext,
  CodegenToolDefinition,
  CodegenToolHandler,
} from './substrate-runtime.ts'

// ---------------------------------------------------------------------------
// Tool definitions.
// ---------------------------------------------------------------------------

export const READ_TOOL_DEF: CodegenToolDefinition = {
  name: 'read',
  description:
    'Read a file from the worktree. Returns the file text. Supports optional 1-indexed line `offset` and `limit` arguments to read a slice of large files.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Worktree-relative file path.' },
      offset: {
        type: 'integer',
        description: '1-indexed line number to start reading from.',
      },
      limit: {
        type: 'integer',
        description: 'Number of lines to read starting at `offset`.',
      },
    },
    required: ['file'],
  },
}

export const WRITE_TOOL_DEF: CodegenToolDefinition = {
  name: 'write',
  description:
    'Write `content` to `file` (creates parent directories as needed). Overwrites any existing file at that path.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Worktree-relative file path.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['file', 'content'],
  },
}

export const EDIT_TOOL_DEF: CodegenToolDefinition = {
  name: 'edit',
  description:
    'Edit `file` by replacing the literal string `old` with `new`. By default replaces the single first occurrence; pass `replace_all: true` to replace every match. Throws if `old` is not found.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Worktree-relative file path.' },
      old: { type: 'string', description: 'Existing string to replace.' },
      new: { type: 'string', description: 'Replacement string.' },
      replace_all: {
        type: 'boolean',
        description: 'When true replace every occurrence (default false).',
      },
    },
    required: ['file', 'old', 'new'],
  },
}

export const BASH_TOOL_DEF: CodegenToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command via `/bin/sh -c` with cwd set to the worktree root. Returns combined stdout (+ STDERR section if non-empty). Exit-non-zero surfaces as `is_error: true`.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      timeout_ms: {
        type: 'integer',
        description: 'Wall-clock timeout in milliseconds (default 60000).',
      },
    },
    required: ['command'],
  },
}

export const GREP_TOOL_DEF: CodegenToolDefinition = {
  name: 'grep',
  description:
    'Search for `pattern` in worktree files (ripgrep when available, POSIX grep otherwise). Returns matching `path:line:text`. Optional `path` narrows the search root; optional `glob` filters by file pattern.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for.' },
      path: {
        type: 'string',
        description: 'Worktree-relative path to search under (default worktree root).',
      },
      glob: {
        type: 'string',
        description: 'Glob filter (e.g. "*.ts").',
      },
    },
    required: ['pattern'],
  },
}

export const GLOB_TOOL_DEF: CodegenToolDefinition = {
  name: 'glob',
  description:
    'List files matching a glob pattern under the worktree. Optional `path` narrows the search root.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts").' },
      path: {
        type: 'string',
        description: 'Worktree-relative path to search under (default worktree root).',
      },
    },
    required: ['pattern'],
  },
}

/** Tool defs exposed to Forge sub-agents. */
export const FORGE_TOOL_DEFS: readonly CodegenToolDefinition[] = [
  READ_TOOL_DEF,
  WRITE_TOOL_DEF,
  EDIT_TOOL_DEF,
  BASH_TOOL_DEF,
  GREP_TOOL_DEF,
  GLOB_TOOL_DEF,
]

/** Tool defs exposed to Argus sub-agents — read + bash only (allowlist gated). */
export const ARGUS_TOOL_DEFS: readonly CodegenToolDefinition[] = [
  READ_TOOL_DEF,
  BASH_TOOL_DEF,
]

/**
 * Tool defs exposed to Atlas sub-agents. Atlas is the research / analysis
 * / ops / strategy / **writing** persona — it produces deliverables, so it
 * needs the full read/write/edit surface plus unrestricted bash for ops
 * (NOT Argus's read-only set, which would leave it physically unable to
 * write its result). Equivalent to `FORGE_TOOL_DEFS`, named separately so
 * the two roles can diverge.
 */
export const ATLAS_TOOL_DEFS: readonly CodegenToolDefinition[] = [
  READ_TOOL_DEF,
  WRITE_TOOL_DEF,
  EDIT_TOOL_DEF,
  BASH_TOOL_DEF,
  GREP_TOOL_DEF,
  GLOB_TOOL_DEF,
]

/**
 * Tool defs exposed to Sentinel sub-agents. Sentinel reviews NON-code work
 * (e.g. an Atlas deliverable) — it verifies, it never produces — so its
 * surface is read-only: read + search, no shell, no write. Distinct from
 * Argus's read+bash set: a document reviewer needs grep/glob over the
 * artifact, not a build shell.
 */
export const SENTINEL_TOOL_DEFS: readonly CodegenToolDefinition[] = [
  READ_TOOL_DEF,
  GREP_TOOL_DEF,
  GLOB_TOOL_DEF,
]

/**
 * Default bash-command allowlist for Argus sub-agents. Every `command`
 * must match one of these regex prefixes (anchored at start of string).
 */
export const DEFAULT_ARGUS_BASH_ALLOWLIST: readonly string[] = [
  '^git show',
  '^git log',
  '^git diff',
  '^bun test',
  '^bunx tsc',
  '^rg',
  '^cat',
  '^ls',
  '^pwd',
]

// ---------------------------------------------------------------------------
// Path scoping.
// ---------------------------------------------------------------------------

interface ResolvedPath {
  ok: true
  absolute: string
}

interface RejectedPath {
  ok: false
  error: { content: string; is_error: true }
}

/**
 * Resolve a worktree-relative path. Rejects absolute paths AND any
 * path whose resolved form escapes `worktree_path` (`..`-traversal).
 */
function resolveScopedPath(
  worktree_path: string,
  arg: unknown,
  argName = 'file',
): ResolvedPath | RejectedPath {
  if (typeof arg !== 'string' || arg.length === 0) {
    return {
      ok: false,
      error: {
        content: `${argName} must be a non-empty string`,
        is_error: true,
      },
    }
  }
  if (isAbsolute(arg)) {
    return {
      ok: false,
      error: {
        content: `path escapes worktree: ${arg}`,
        is_error: true,
      },
    }
  }
  const ws = resolvePath(worktree_path)
  const abs = resolvePath(ws, arg)
  // Ensure abs is exactly `ws` or starts with `ws + sep`.
  if (abs !== ws && !abs.startsWith(ws + sep)) {
    return {
      ok: false,
      error: {
        content: `path escapes worktree: ${arg}`,
        is_error: true,
      },
    }
  }
  return { ok: true, absolute: abs }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

export const readFileScoped: CodegenToolHandler = async (input, ctx) => {
  const resolved = resolveScopedPath(ctx.worktree_path, input.file)
  if (!resolved.ok) return resolved.error
  try {
    const raw = await readFile(resolved.absolute, 'utf8')
    const offset = typeof input.offset === 'number' ? input.offset : undefined
    const limit = typeof input.limit === 'number' ? input.limit : undefined
    if (offset === undefined && limit === undefined) {
      return { content: raw }
    }
    const lines = raw.split('\n')
    const start = offset !== undefined && offset > 0 ? offset - 1 : 0
    const end = limit !== undefined ? start + limit : lines.length
    return { content: lines.slice(start, end).join('\n') }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    }
  }
}

export const writeFileScoped: CodegenToolHandler = async (input, ctx) => {
  const resolved = resolveScopedPath(ctx.worktree_path, input.file)
  if (!resolved.ok) return resolved.error
  if (typeof input.content !== 'string') {
    return { content: 'content must be a string', is_error: true }
  }
  try {
    await mkdir(dirname(resolved.absolute), { recursive: true })
    await writeFile(resolved.absolute, input.content, 'utf8')
    return { content: `wrote ${resolved.absolute}` }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    }
  }
}

export const editFileScoped: CodegenToolHandler = async (input, ctx) => {
  const resolved = resolveScopedPath(ctx.worktree_path, input.file)
  if (!resolved.ok) return resolved.error
  const oldStr = input.old
  const newStr = input.new
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
    return { content: 'old and new must be strings', is_error: true }
  }
  const replace_all = input.replace_all === true
  try {
    const current = await readFile(resolved.absolute, 'utf8')
    if (!current.includes(oldStr)) {
      return {
        content: `old string not found in ${resolved.absolute}`,
        is_error: true,
      }
    }
    let next: string
    if (replace_all) {
      next = current.split(oldStr).join(newStr)
    } else {
      const idx = current.indexOf(oldStr)
      next = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length)
    }
    await writeFile(resolved.absolute, next, 'utf8')
    return { content: `edited ${resolved.absolute}` }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    }
  }
}

/**
 * Build a bash handler. When `allowlist` is non-null every command
 * must match one of the regex prefixes; when null no allowlist is
 * enforced (Forge sub-agents).
 */
export function bashScopedFactory(
  allowlist: readonly string[] | null,
): CodegenToolHandler {
  const regexes =
    allowlist === null ? null : allowlist.map((p) => new RegExp(p))
  return async (input, ctx) => {
    const command = input.command
    if (typeof command !== 'string' || command.length === 0) {
      return { content: 'command must be a non-empty string', is_error: true }
    }
    if (regexes !== null && !regexes.some((re) => re.test(command))) {
      return {
        content: `command not allowed by allowlist: ${command}`,
        is_error: true,
      }
    }
    const timeout_ms =
      typeof input.timeout_ms === 'number' && input.timeout_ms > 0
        ? input.timeout_ms
        : 60_000
    try {
      const proc = Bun.spawn(['/bin/sh', '-c', command], {
        cwd: ctx.worktree_path,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeout_ms,
      })
      const [stdout_text, stderr_text, exit_code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const combined =
        stderr_text.length > 0
          ? `${stdout_text}\nSTDERR: ${stderr_text}`
          : stdout_text
      if (exit_code !== 0) {
        return {
          content: `${combined}\nEXIT: ${exit_code}`,
          is_error: true,
        }
      }
      return { content: combined }
    } catch (err) {
      return {
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      }
    }
  }
}

export const grepScoped: CodegenToolHandler = async (input, ctx) => {
  const pattern = input.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'pattern must be a non-empty string', is_error: true }
  }
  let search_root = ctx.worktree_path
  if (typeof input.path === 'string' && input.path.length > 0) {
    const resolved = resolveScopedPath(ctx.worktree_path, input.path, 'path')
    if (!resolved.ok) return resolved.error
    search_root = resolved.absolute
  }
  const glob =
    typeof input.glob === 'string' && input.glob.length > 0 ? input.glob : null

  // Prefer ripgrep, but fall back to POSIX grep when `rg` is not on PATH —
  // a stock GitHub runner (and many self-hosters' CI boxes) ship without
  // ripgrep, which otherwise makes this tool error out. Both binaries emit
  // `path:line:text` with `-n` and exit 1 on no-match, so the caller sees an
  // identical shape either way. grep is given the recursion + ignore flags
  // that rg applies implicitly (skip .git/node_modules) to keep results sane.
  const cmd =
    Bun.which('rg') !== null
      ? [
          'rg',
          '--color=never',
          '-n',
          ...(glob ? ['--glob', glob] : []),
          '--',
          pattern,
          search_root,
        ]
      : [
          'grep',
          '-rn',
          '--color=never',
          '--exclude-dir=.git',
          '--exclude-dir=node_modules',
          ...(glob ? [`--include=${glob}`] : []),
          '-e',
          pattern,
          search_root,
        ]
  try {
    const proc = Bun.spawn(cmd, {
      cwd: ctx.worktree_path,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    })
    const [stdout_text, stderr_text, exit_code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // rg and grep both exit 1 on no-matches (not an error condition).
    if (exit_code !== 0 && exit_code !== 1) {
      return {
        content: `${stdout_text}\nSTDERR: ${stderr_text}\nEXIT: ${exit_code}`,
        is_error: true,
      }
    }
    return { content: stdout_text }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    }
  }
}

export const globScoped: CodegenToolHandler = async (input, ctx) => {
  const pattern = input.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { content: 'pattern must be a non-empty string', is_error: true }
  }
  let search_root = ctx.worktree_path
  if (typeof input.path === 'string' && input.path.length > 0) {
    const resolved = resolveScopedPath(ctx.worktree_path, input.path, 'path')
    if (!resolved.ok) return resolved.error
    search_root = resolved.absolute
  }
  try {
    const glob = new Bun.Glob(pattern)
    const matches: string[] = []
    for await (const m of glob.scan({ cwd: search_root })) {
      matches.push(m)
    }
    matches.sort()
    return { content: matches.join('\n') }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled handler factories.
// ---------------------------------------------------------------------------

/** Forge handler bundle — full read/write/edit/bash/grep/glob surface. */
export function buildForgeToolHandlers(): Record<string, CodegenToolHandler> {
  return {
    read: readFileScoped,
    write: writeFileScoped,
    edit: editFileScoped,
    bash: bashScopedFactory(null),
    grep: grepScoped,
    glob: globScoped,
  }
}

/**
 * Argus handler bundle — read + (allowlist-gated) bash only. Pass a
 * custom allowlist to widen / narrow the bash surface; defaults to
 * `DEFAULT_ARGUS_BASH_ALLOWLIST`.
 */
export function buildArgusToolHandlers(
  allowlist: readonly string[] = DEFAULT_ARGUS_BASH_ALLOWLIST,
): Record<string, CodegenToolHandler> {
  return {
    read: readFileScoped,
    bash: bashScopedFactory(allowlist),
  }
}

/**
 * Atlas handler bundle — full read/write/edit/grep/glob plus UNRESTRICTED
 * bash. Atlas writes its own deliverable and runs ops commands, so (unlike
 * Argus) its bash is not allowlist-gated. Matches `ATLAS_TOOL_DEFS`.
 */
export function buildAtlasToolHandlers(): Record<string, CodegenToolHandler> {
  return {
    read: readFileScoped,
    write: writeFileScoped,
    edit: editFileScoped,
    bash: bashScopedFactory(null),
    grep: grepScoped,
    glob: globScoped,
  }
}

/**
 * Sentinel handler bundle — read + search only, matching
 * `SENTINEL_TOOL_DEFS`. No bash and no write/edit: a non-code reviewer
 * inspects the artifact, it never mutates it or shells out.
 */
export function buildSentinelToolHandlers(): Record<string, CodegenToolHandler> {
  return {
    read: readFileScoped,
    grep: grepScoped,
    glob: globScoped,
  }
}

// Re-export the context type for convenience.
export type { CodegenToolContext }
