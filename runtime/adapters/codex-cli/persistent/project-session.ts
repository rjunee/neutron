import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { atomicWriteFileSync } from '../../../atomic-write.ts'
import { HerdrHost } from '../../claude-code/persistent/herdr-host.ts'
import type {
  AdoptableHost,
  PtyChild,
  PtySpawnOpts,
} from '../../claude-code/persistent/pty-host.ts'

export type CodexSessionRecovery = 'started' | 'adopted' | 'restarted-after-loss'

interface RegistryEntry {
  readonly project_id: string
  readonly pane_handle: string
  readonly argv: readonly string[]
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

function isCodexArgv(argv: readonly string[], expected: readonly string[]): boolean {
  if (argv.length === 0 || expected.length === 0) return false
  if (sameArgv(argv, expected)) return true
  if (!/^(?:node|nodejs|bun|deno)$/.test(basename(argv[0] ?? ''))) return false
  const script = basename(argv[1] ?? '')
  const launcher = basename(expected[0] ?? '')
  // The packaged Codex launcher resolves to bin/codex.js.
  return (script === launcher || (launcher === 'codex' && script === 'codex.js'))
    && sameArgv(argv.slice(2), expected.slice(1))
}

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
  ) {
    this.projectId = projectId
    this.paneHandle = paneHandle
    this.recovery = recovery
  }

  /** Resolves after the host acknowledges both text delivery and Enter. */
  async submitLine(line: string): Promise<void> {
    if (line.includes('\r') || line.includes('\n')) {
      throw new Error('codex project session refuses embedded line terminators')
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
      if (this.child.hasExited()) throw new Error('codex project session refused: session is not running')
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
  private readonly opening = new Map<string, Promise<CodexProjectSession>>()

  constructor(private readonly options: CodexProjectSessionHostOptions) {
    this.host = options.host ?? new HerdrHost()
    this.bin = options.bin ?? 'codex'
  }

  open(options: OpenCodexProjectSessionOptions): Promise<CodexProjectSession> {
    if (options.projectId === '') return Promise.reject(new Error('codex project session requires a project id'))
    const existing = this.opening.get(options.projectId)
    if (existing !== undefined) return existing
    const pending = this.openOne(options).catch((error) => {
      this.opening.delete(options.projectId)
      throw error
    })
    this.opening.set(options.projectId, pending)
    return pending
  }

  private async openOne(options: OpenCodexProjectSessionOptions): Promise<CodexProjectSession> {
    const argv = [this.bin, '--enable', 'multi_agent_v2']
    if (options.model !== undefined) argv.push('--model', options.model)
    const spawnOptions: PtySpawnOpts = {
      cwd: options.cwd,
      env: options.env,
      label: `neutron-codex-${options.projectId}`,
      onScreen: () => {},
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
        if (!isCodexArgv(inspection.argv, recorded.argv) || !sameArgv(recorded.argv, argv)) {
          throw new Error('codex project session refused: recorded pane identity does not match this project session')
        }
        child = await this.host.attach(recorded.pane_handle, spawnOptions)
        recovery = 'adopted'
      } else {
        child = await this.host.spawn(argv, spawnOptions)
        recovery = 'restarted-after-loss'
      }
    } else {
      child = await this.host.spawn(argv, spawnOptions)
      recovery = 'started'
    }

    const paneHandle = child.paneHandle ?? ''
    if (paneHandle === '') {
      child.kill()
      throw new Error('codex project session refused: host returned no restart-survival handle')
    }
    registry.sessions[options.projectId] = {
      project_id: options.projectId,
      pane_handle: paneHandle,
      argv,
    }
    writeRegistry(this.options.registryPath, registry)
    child.beginOutput?.()
    return new CodexProjectSession(options.projectId, paneHandle, recovery, child)
  }
}
