import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteFileSync } from '../../../atomic-write.ts'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'
import type {
  AdoptableHost,
  PtyChild,
  PtySpawnOpts,
} from '../../claude-code/persistent/pty-host.ts'
import { detectCodexScreenPrompt, type CodexScreenPrompt } from './screen-prompts.ts'

export type CodexSessionRecovery = 'started' | 'adopted' | 'restarted-after-loss'

interface RegistryEntry {
  readonly project_id: string
  readonly pane_handle: string
  readonly cwd?: string
  readonly argv: readonly string[]
  readonly identity?: readonly string[]
}

interface RegistryFile {
  readonly version: 1
  readonly sessions: Record<string, RegistryEntry>
}

export interface OpenCodexProjectSessionOptions {
  readonly projectId: string
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly model?: string
}

export interface CodexProjectSessionHostOptions {
  readonly registryPath: string
  readonly host?: AdoptableHost
  readonly bin?: string
}

function emptyRegistry(): RegistryFile {
  return { version: 1, sessions: {} }
}

function readRegistry(path: string): RegistryFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
      throw new Error('unsupported registry shape')
    }
    return { version: 1, sessions: parsed.sessions as Record<string, RegistryEntry> }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return emptyRegistry()
    throw new Error(`codex project session registry is unreadable: ${(error as Error).message}`)
  }
}

function writeRegistry(path: string, registry: RegistryFile): void {
  atomicWriteFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

/** Canonical exec vector: real executable, real script (for a shebang), arguments. */
function resolveIdentity(argv: readonly string[], options: OpenCodexProjectSessionOptions): string[] {
  const executable = (name: string): string => {
    const path = name.includes('/') ? resolve(options.cwd, name)
      : Bun.which(name, { PATH: options.env.PATH ?? process.env.PATH ?? '', cwd: options.cwd })
    if (!path) throw new Error('executable unavailable')
    return realpathSync(path)
  }
  const program = executable(argv[0] ?? '')
  const fd = openSync(program, 'r')
  const header = Buffer.alloc(256)
  let size: number
  try { size = readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
  const firstLine = header.subarray(0, size).toString().split('\n')[0] ?? ''
  if (firstLine.startsWith('#!')) {
    const words = firstLine.slice(2).trim().split(/\s+/)
    // env is a launcher, not the process identity left after exec.
    const command = words[0] === '/usr/bin/env' ? words.slice(1) : words
    if (command.length !== 1) throw new Error('unsupported executable shebang')
    return [executable(command[0]!), program, ...argv.slice(1)]
  }
  // Resolve a script operand without guessing interpreter or script basenames.
  let args = argv.slice(1)
  if (args[0] && !args[0].startsWith('-')) {
    args = [realpathSync(resolve(options.cwd, args[0])), ...args.slice(1)]
  }
  return [program, ...args]
}

function matchesIdentity(argv: readonly string[], expected: readonly string[] | undefined,
  options: OpenCodexProjectSessionOptions): boolean {
  try {
    return expected !== undefined && sameArgv(resolveIdentity(argv, options), expected)
  } catch {
    return false
  }
}

export class CodexApprovalRefusedError extends Error {}

export class CodexProjectSession {
  readonly projectId: string
  readonly paneHandle: string
  readonly recovery: CodexSessionRecovery
  private turnTail: Promise<void> = Promise.resolve()

  constructor(
    projectId: string,
    paneHandle: string,
    recovery: CodexSessionRecovery,
    private readonly child: PtyChild,
    private readonly readScreenPrompt: () => CodexScreenPrompt | undefined = () => undefined,
  ) {
    this.projectId = projectId
    this.paneHandle = paneHandle
    this.recovery = recovery
  }

  /** The interactive prompt visible on the latest rendered screen, if recognised. */
  screenPrompt(): CodexScreenPrompt | undefined {
    return this.readScreenPrompt()
  }

  /** Answer the currently rendered approval through the acknowledged input path. */
  async answerApproval(decision: 'allow' | 'deny'): Promise<void> {
    const prompt = this.readScreenPrompt()
    if (prompt === undefined) throw new Error('codex project session approval unknown: no recognised prompt is visible')
    if (prompt.kind !== 'approval') {
      throw new CodexApprovalRefusedError('codex project session refused: the visible prompt is not an approval')
    }
    await this.submit(decision === 'allow' ? prompt.allowKey : prompt.denyKey, prompt)
  }

  /** Resolves after the host acknowledges both text delivery and Enter. */
  async submitLine(line: string): Promise<void> {
    await this.submit(line)
  }

  private async submit(line: string, expectedPrompt?: CodexScreenPrompt): Promise<void> {
    if (line.includes('\r') || line.includes('\n') || line.includes('\x1b')) {
      throw new Error('codex project session refuses embedded line terminators or escape characters')
    }
    const submit = this.child.submitLine
    if (submit === undefined) {
      throw new Error('codex project session refused: terminal host cannot acknowledge submission')
    }

    let release: () => void = () => {}
    const previous = this.turnTail
    this.turnTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (expectedPrompt !== undefined && this.readScreenPrompt() !== expectedPrompt) {
        throw new CodexApprovalRefusedError('codex project session refused: approval prompt changed while queued')
      }
      if (this.child.hasExited()) throw new Error('codex project session refused: session is not running')
      // The terminal host frames the paste and sends Enter. Passing a frame here
      // would nest paste markers in the terminal payload.
      await submit.call(this.child, line)
    } finally {
      release()
    }
  }

  /** A pre-dispatch observation only; submission can still fail after this check. */
  isLive(): boolean {
    return !this.child.hasExited()
  }

  /** Stops this gateway from polling or writing while leaving the herdr pane alive. */
  detach(): void {
    this.child.detach?.()
  }
}

export class CodexProjectSessionHost {
  private readonly host: AdoptableHost
  private readonly bin: string
  private readonly opening = new Map<string, { cwd: string; session: Promise<CodexProjectSession> }>()

  constructor(private readonly options: CodexProjectSessionHostOptions) {
    this.host = options.host ?? new HerdrHost()
    this.bin = options.bin ?? 'codex'
  }

  async open(options: OpenCodexProjectSessionOptions): Promise<CodexProjectSession> {
    if (options.projectId === '') return Promise.reject(new Error('codex project session requires a project id'))
    const cwd = realpathSync(options.cwd)
    const existing = this.opening.get(options.projectId)
    if (existing !== undefined) {
      if (existing.cwd !== cwd) throw new Error(
        'codex project session refused: project working directory changed',
      )
      return existing.session
    }
    const pending = this.openOne({ ...options, cwd }).catch((error) => {
      this.opening.delete(options.projectId)
      throw error
    })
    this.opening.set(options.projectId, { cwd, session: pending })
    return pending
  }

  private async openOne(options: OpenCodexProjectSessionOptions): Promise<CodexProjectSession> {
    const argv = [this.bin, '--enable', 'multi_agent_v2']
    if (options.model !== undefined) argv.push('--model', options.model)
    let identity: string[]
    try { identity = resolveIdentity(argv, options) } catch {
      throw new Error('codex project session refused: launch identity cannot be resolved')
    }
    let screenPrompt: CodexScreenPrompt | undefined
    const spawnOptions: PtySpawnOpts = {
      cwd: options.cwd,
      env: options.env,
      label: `neutron-codex-${options.projectId}`,
      onScreen: (screen) => { screenPrompt = detectCodexScreenPrompt(screen) },
    }
    const registry = readRegistry(this.options.registryPath)
    const recorded = registry.sessions[options.projectId]
    let child: PtyChild
    let recovery: CodexSessionRecovery

    if (recorded !== undefined) {
      const inspection = await this.host.inspectHandle(recorded.pane_handle)
      if (inspection.kind === 'unavailable') {
        throw new Error(`codex project session recovery unknown: ${inspection.reason}`)
      }
      if (inspection.kind === 'live') {
        if (recorded.cwd === undefined) {
          throw new Error('codex project session recovery unknown: recorded working directory is missing')
        }
        if (recorded.cwd !== options.cwd) {
          throw new Error('codex project session refused: project working directory changed')
        }
        if (!matchesIdentity(inspection.argv, recorded.identity, options) || !sameArgv(recorded.argv, argv)
          || (recorded.identity !== undefined && !sameArgv(recorded.identity, identity))) {
          throw new Error('codex project session refused: recorded pane identity does not match this project session')
        }
        child = await this.host.attach(recorded.pane_handle, spawnOptions)
        recovery = 'adopted'
      } else {
        child = await this.host.spawn(identity, spawnOptions)
        recovery = 'restarted-after-loss'
      }
    } else {
      child = await this.host.spawn(identity, spawnOptions)
      recovery = 'started'
    }

    const paneHandle = child.paneHandle ?? ''
    if (paneHandle === '') {
      child.kill()
      throw new Error('codex project session refused: host returned no restart-survival handle')
    }
    // Another project can finish opening while spawn/attach is awaited. Merge
    // into the latest registry, with no await between this read and the write.
    const latestRegistry = readRegistry(this.options.registryPath)
    latestRegistry.sessions[options.projectId] = {
      project_id: options.projectId,
      cwd: options.cwd,
      pane_handle: paneHandle,
      argv,
      identity,
    }
    writeRegistry(this.options.registryPath, latestRegistry)
    child.beginOutput?.()
    return new CodexProjectSession(options.projectId, paneHandle, recovery, child, () => screenPrompt)
  }
}
