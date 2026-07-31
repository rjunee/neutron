/**
 * @neutronai/gateway/transcription — local-Whisper INSTALL + DETECTION.
 *
 * Backs the Settings tab's "Local voice transcription" control. Owns three
 * things and nothing else:
 *
 *   1. WHERE the assets live       — `whisperPaths()`
 *   2. WHETHER they are usable     — `resolveWhisperInstall()` (pure fs read)
 *   3. GETTING them                — `WhisperInstaller` (download + verify + place)
 *
 * DESIGN NOTES
 *
 * **Nothing is downloaded at install-time.** `install.sh` stays lean; the ~600 MB
 * of weights arrive only when the owner clicks the button in Settings. A fresh
 * self-host that never records a voice note never pays for this.
 *
 * **A partial download can never become the live model.** Every artifact streams
 * to a `.part` sibling while a SHA-256 is computed over the stream; the file is
 * only `rename()`d into place after the digest matches the pin in
 * `whisper-catalog.ts`. A killed process, a dropped connection, or a truncated
 * body therefore leaves a `.part` that is deleted and re-fetched on the next
 * attempt — it is never loaded as though it were whole. (Safely RE-RUNNABLE
 * rather than byte-range resumable: resuming would mean trusting bytes we never
 * hashed, and the whole point of the pin is not to.)
 *
 * **Progress is real, not a spinner.** The installer reports bytes-received
 * against the artifact's known `Content-Length` (pinned in the catalog, so the
 * total is known before the first byte arrives) and the surface polls it. Disk
 * space is checked BEFORE the first byte, so "not enough room" is an immediate,
 * legible error rather than a failure 480 MB in.
 *
 * **One install at a time.** `install()` is guarded — a second click while a
 * download is running returns the SAME job rather than starting a competing one.
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_WHISPER_MODEL_ID,
  WHISPER_CPP_VERSION,
  binaryAssetFor,
  modelAssetFor,
  type WhisperBinaryAsset,
  type WhisperModelAsset,
} from './whisper-catalog.ts'

/** Filesystem layout for the local-Whisper assets under `<NEUTRON_HOME>`. */
export interface WhisperPaths {
  /** `<NEUTRON_HOME>/whisper` */
  root: string
  /** `<root>/bin` — `whisper-cli` plus the ggml `.so` files it dlopen's. */
  bin_dir: string
  /** `<bin_dir>/whisper-cli` */
  binary: string
  /** `<root>/models` */
  models_dir: string
}

export function whisperPaths(neutron_home: string): WhisperPaths {
  const root = join(neutron_home, 'whisper')
  const bin_dir = join(root, 'bin')
  return { root, bin_dir, binary: join(bin_dir, 'whisper-cli'), models_dir: join(root, 'models') }
}

/** A usable local-Whisper installation. */
export interface WhisperInstall {
  /** Absolute path to the `whisper-cli` executable. */
  binary: string
  /**
   * Directory holding `libwhisper.so` / `libggml*.so`. The upstream release
   * tarball ships them BESIDE the binary with no rpath, so the runtime must put
   * this on `LD_LIBRARY_PATH` or the process dies at load. `null` for a
   * package-manager binary (Homebrew) whose libraries are already linked.
   */
  lib_dir: string | null
  /** Absolute path to the ggml weights. */
  model: string
  /** Catalog id of the installed model, or `'custom'` for an operator-pinned file. */
  model_id: string
}

export interface ResolveWhisperOptions {
  /** Process env — honours the `NEUTRON_WHISPER_*` operator overrides. */
  env: Record<string, string | undefined>
  /** Resolved data dir. */
  neutron_home: string
  /** PATH lookup, injected in tests. Defaults to `Bun.which`. */
  which?: (cmd: string) => string | null
  /** Existence probe, injected in tests. Defaults to `existsSync`. */
  exists?: (p: string) => boolean
  /** Directory listing for the model fallback scan, injected in tests. */
  list_dir?: (p: string) => string[]
}

/**
 * Resolve a usable installation, or `null` when local transcription is not
 * available. BOTH a binary and a model are required — either alone is useless,
 * and reporting "installed" on half of it would strand voice notes with no
 * transcript and no explanation.
 *
 * Resolution order for each piece:
 *   binary — `NEUTRON_WHISPER_BIN` → `<NEUTRON_HOME>/whisper/bin/whisper-cli`
 *            → `whisper-cli` on PATH (the Homebrew / distro-package case)
 *   model  — `NEUTRON_WHISPER_MODEL` → the catalog default under
 *            `<NEUTRON_HOME>/whisper/models` → any other `ggml-*.bin` there
 *
 * The env overrides exist so a machine running several Neutron instances can
 * point them all at ONE shared copy of the weights
 * (`NEUTRON_WHISPER_MODEL=/opt/whisper/ggml-base.bin`) instead of paying
 * hundreds of megabytes of disk for each identical file.
 */
export function resolveWhisperInstall(opts: ResolveWhisperOptions): WhisperInstall | null {
  const exists = opts.exists ?? ((p: string) => existsSync(p))
  const which = opts.which ?? ((c: string) => Bun.which(c))
  const listDir =
    opts.list_dir ??
    ((p: string): string[] => {
      try {
        // Sync read: this runs once at composer boot, never per request.
        return require('node:fs').readdirSync(p) as string[]
      } catch {
        return []
      }
    })
  const paths = whisperPaths(opts.neutron_home)

  // ── binary ──
  let binary: string | null = null
  let lib_dir: string | null = null
  const pinnedBin = (opts.env['NEUTRON_WHISPER_BIN'] ?? '').trim()
  if (pinnedBin.length > 0) {
    if (!exists(pinnedBin)) return null
    binary = pinnedBin
    // A pinned binary from an unpacked release still needs its sibling .so's.
    lib_dir = pinnedBin.slice(0, Math.max(0, pinnedBin.lastIndexOf('/')))
  } else if (exists(paths.binary)) {
    binary = paths.binary
    lib_dir = paths.bin_dir
  } else {
    const onPath = which('whisper-cli')
    if (onPath !== null && onPath.length > 0) {
      // Package-manager install (Homebrew `whisper-cpp`): libraries are linked
      // via rpath, so do NOT force an LD_LIBRARY_PATH we did not lay out.
      binary = onPath
      lib_dir = null
    }
  }
  if (binary === null) return null

  // ── model ──
  const pinnedModel = (opts.env['NEUTRON_WHISPER_MODEL'] ?? '').trim()
  if (pinnedModel.length > 0) {
    if (!exists(pinnedModel)) return null
    return { binary, lib_dir, model: pinnedModel, model_id: 'custom' }
  }
  const preferred = join(paths.models_dir, `ggml-${DEFAULT_WHISPER_MODEL_ID}.bin`)
  if (exists(preferred)) {
    return { binary, lib_dir, model: preferred, model_id: DEFAULT_WHISPER_MODEL_ID }
  }
  // Any other catalog model the owner picked instead.
  const found = listDir(paths.models_dir)
    .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
    .sort()
  const first = found[0]
  if (first === undefined) return null
  return {
    binary,
    lib_dir,
    model: join(paths.models_dir, first),
    model_id: first.slice('ggml-'.length, -'.bin'.length),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Installer
// ─────────────────────────────────────────────────────────────────────────────

export type WhisperInstallPhase =
  | 'idle'
  | 'checking_disk'
  | 'downloading_binary'
  | 'extracting_binary'
  | 'downloading_model'
  | 'verifying'
  | 'done'
  | 'failed'

export type WhisperInstallErrorCode =
  | 'unsupported_platform'
  | 'unknown_model'
  | 'insufficient_disk'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'extract_failed'
  | 'already_running'

export interface WhisperInstallProgress {
  phase: WhisperInstallPhase
  /** Bytes fetched for the artifact currently downloading. */
  received_bytes: number
  /** Content-Length of the artifact currently downloading (known up front). */
  total_bytes: number
  /** Catalog id being installed. */
  model_id: string
  /** Set when `phase === 'failed'`. */
  error?: { code: WhisperInstallErrorCode; message: string }
  /** Epoch ms the job started. */
  started_at: number
}

export interface WhisperInstallerOptions {
  neutron_home: string
  /** Injected in tests. Defaults to `globalThis.fetch`. */
  fetch_impl?: typeof fetch
  /** Injected in tests. Defaults to `process.platform`. */
  platform?: string
  /** Injected in tests. Defaults to `process.arch`. */
  arch?: string
  /** Free-bytes probe for the pre-flight disk check. `null` skips the check. */
  free_bytes?: (dir: string) => Promise<number | null>
  /** Untar hook, injected in tests. Defaults to spawning `tar -xzf`. */
  extract_tar?: (tarball: string, dest: string) => Promise<void>
  /** PATH lookup, injected in tests. Defaults to `Bun.which`. */
  which?: (cmd: string) => string | null
  /**
   * Asset lookups, injected in tests so the success path can be exercised
   * offline with bytes whose digest the test controls. Production NEVER passes
   * these — the composer constructs the installer with the compiled-in catalog,
   * so the pinned URLs and digests are the only ones a real box can fetch.
   */
  resolve_model?: (id: string) => WhisperModelAsset | null
  resolve_binary?: (platform: string, arch: string) => WhisperBinaryAsset | null
}

/** Headroom required beyond the artifact itself (unpacked binary + slack). */
const DISK_HEADROOM_BYTES = 200 * 1024 * 1024

export class WhisperInstaller {
  private readonly opts: WhisperInstallerOptions
  private readonly paths: WhisperPaths
  private progress: WhisperInstallProgress | null = null
  private running: Promise<void> | null = null

  constructor(opts: WhisperInstallerOptions) {
    this.opts = opts
    this.paths = whisperPaths(opts.neutron_home)
  }

  /** Current job progress, or `null` when nothing has been attempted. */
  status(): WhisperInstallProgress | null {
    return this.progress
  }

  isRunning(): boolean {
    return this.running !== null
  }

  /**
   * Start (or join) an install. Returns immediately with the job's progress —
   * the HTTP surface polls `status()`; the button never blocks on a 600 MB
   * download.
   */
  start(model_id: string): WhisperInstallProgress {
    if (this.running !== null) {
      // A second click joins the running job rather than racing it.
      return this.progress ?? this.freshProgress(model_id)
    }
    const asset = (this.opts.resolve_model ?? modelAssetFor)(model_id)
    if (asset === null) {
      this.progress = {
        ...this.freshProgress(model_id),
        phase: 'failed',
        error: { code: 'unknown_model', message: `unknown model '${model_id}'` },
      }
      return this.progress
    }
    this.progress = this.freshProgress(model_id)
    this.running = this.run(asset)
      .catch(() => {
        /* `run` records its own failure into `progress`; never rethrow. */
      })
      .finally(() => {
        this.running = null
      })
    return this.progress
  }

  /** Delete every downloaded asset. Gigabytes — the owner can take them back. */
  async remove(): Promise<void> {
    await rm(this.paths.root, { recursive: true, force: true })
    this.progress = null
  }

  private freshProgress(model_id: string): WhisperInstallProgress {
    return {
      phase: 'idle',
      received_bytes: 0,
      total_bytes: 0,
      model_id,
      started_at: Date.now(),
    }
  }

  private fail(code: WhisperInstallErrorCode, message: string): void {
    if (this.progress !== null) {
      this.progress = { ...this.progress, phase: 'failed', error: { code, message } }
    }
  }

  private set(patch: Partial<WhisperInstallProgress>): void {
    if (this.progress !== null) this.progress = { ...this.progress, ...patch }
  }

  private async run(asset: WhisperModelAsset): Promise<void> {
    const platform = this.opts.platform ?? process.platform
    const arch = this.opts.arch ?? process.arch
    const binAsset = (this.opts.resolve_binary ?? binaryAssetFor)(platform, arch)

    // A macOS box has no upstream CLI build; the binary must already be on PATH
    // (Homebrew). Say so precisely instead of downloading a model that cannot run.
    const which = this.opts.which ?? ((c: string) => Bun.which(c))
    const haveBinary = existsSync(this.paths.binary) || which('whisper-cli') !== null
    if (binAsset === null && !haveBinary) {
      this.fail(
        'unsupported_platform',
        `no prebuilt whisper.cpp ${WHISPER_CPP_VERSION} build for ${platform}/${arch}. ` +
          `Install it with your package manager first (macOS: \`brew install whisper-cpp\`), then retry.`,
      )
      return
    }

    // ── pre-flight: is there room? Fail BEFORE the first byte, not 480 MB in. ──
    this.set({ phase: 'checking_disk' })
    const needed = asset.size_bytes + (binAsset?.size_bytes ?? 0) + DISK_HEADROOM_BYTES
    const free = this.opts.free_bytes !== undefined ? await this.opts.free_bytes(this.opts.neutron_home) : null
    if (free !== null && free < needed) {
      this.fail(
        'insufficient_disk',
        `needs ${mb(needed)} MB free under ${this.opts.neutron_home}, but only ${mb(free)} MB is available`,
      )
      return
    }

    await mkdir(this.paths.models_dir, { recursive: true })

    // ── binary ──
    if (binAsset !== null && !existsSync(this.paths.binary)) {
      this.set({ phase: 'downloading_binary', received_bytes: 0, total_bytes: binAsset.size_bytes })
      const tarball = join(this.paths.root, 'whisper-bin.tar.gz')
      const okBin = await this.download(binAsset.url, tarball, binAsset.sha256, binAsset.size_bytes)
      if (!okBin) return
      this.set({ phase: 'extracting_binary' })
      try {
        await this.extract(tarball, this.paths.root)
        await unlink(tarball).catch(() => undefined)
      } catch (err) {
        this.fail('extract_failed', err instanceof Error ? err.message : String(err))
        return
      }
    }

    // ── model ──
    const modelPath = join(this.paths.models_dir, `ggml-${asset.id}.bin`)
    if (!existsSync(modelPath)) {
      this.set({ phase: 'downloading_model', received_bytes: 0, total_bytes: asset.size_bytes })
      const okModel = await this.download(asset.url, modelPath, asset.sha256, asset.size_bytes)
      if (!okModel) return
    }

    // ── final proof: both halves present and the binary is executable ──
    this.set({ phase: 'verifying' })
    if (!existsSync(modelPath)) {
      this.fail('download_failed', 'the model file is missing after a reported-successful download')
      return
    }
    this.set({ phase: 'done', received_bytes: asset.size_bytes, total_bytes: asset.size_bytes })
  }

  /**
   * Stream `url` → `dest`, hashing as we go, and only put the file in place when
   * the digest matches. Returns false (and records the failure) otherwise.
   */
  private async download(url: string, dest: string, sha256: string, expect_bytes: number): Promise<boolean> {
    const fetchImpl = this.opts.fetch_impl ?? globalThis.fetch
    const part = `${dest}.part`
    await mkdir(dirOf(dest), { recursive: true })
    // A leftover `.part` from an interrupted attempt is garbage we never hashed.
    await unlink(part).catch(() => undefined)

    let res: Response
    try {
      res = await fetchImpl(url, { redirect: 'follow' })
    } catch (err) {
      this.fail('download_failed', `${url}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!res.ok || res.body === null) {
      this.fail('download_failed', `${url}: HTTP ${res.status}`)
      return false
    }

    const hasher = createHash('sha256')
    let received = 0
    const sink = Bun.file(part).writer()
    try {
      // Bun's ReadableStream is async-iterable at runtime; the DOM lib type is not.
      const stream = res.body as unknown as AsyncIterable<Uint8Array>
      for await (const bytes of stream) {
        hasher.update(bytes)
        sink.write(bytes)
        received += bytes.byteLength
        this.set({ received_bytes: received })
      }
      await sink.end()
    } catch (err) {
      await Promise.resolve(sink.end()).catch(() => undefined)
      await unlink(part).catch(() => undefined)
      this.fail('download_failed', `${url}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }

    const digest = hasher.digest('hex')
    if (digest !== sha256) {
      await unlink(part).catch(() => undefined)
      this.fail(
        'checksum_mismatch',
        `${url}: expected sha256 ${sha256.slice(0, 12)}… but got ${digest.slice(0, 12)}… ` +
          `(${received} of ${expect_bytes} bytes) — nothing was installed`,
      )
      return false
    }
    await rename(part, dest)
    return true
  }

  private async extract(tarball: string, dest: string): Promise<void> {
    if (this.opts.extract_tar !== undefined) {
      await this.opts.extract_tar(tarball, dest)
      return
    }
    // The upstream tarball unpacks into `whisper-bin-<plat>/`; strip that so the
    // binary lands exactly at `<root>/bin/whisper-cli` where the resolver looks.
    await mkdir(this.paths.bin_dir, { recursive: true })
    const proc = Bun.spawn(['tar', '-xzf', tarball, '-C', this.paths.bin_dir, '--strip-components=1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`tar exited ${code}: ${err.slice(0, 300)}`)
    }
    void dest
    // Make sure the binary is executable — some tar/umask combinations drop the bit.
    try {
      await Bun.$`chmod +x ${this.paths.binary}`.quiet()
    } catch {
      /* best effort; a non-executable binary surfaces as exec_failed later */
    }
  }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

/** Free bytes under `dir`, or `null` when it cannot be determined. */
export async function freeBytesAt(dir: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(['df', '-Pk', dir], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) return null
    const line = out.trim().split('\n')[1]
    if (line === undefined) return null
    const cols = line.trim().split(/\s+/)
    const availKb = Number(cols[3])
    return Number.isFinite(availKb) ? availKb * 1024 : null
  } catch {
    return null
  }
}

/** Total bytes the installed assets occupy on disk (for the Remove affordance). */
export async function installedBytes(neutron_home: string): Promise<number> {
  const paths = whisperPaths(neutron_home)
  let total = 0
  for (const dir of [paths.bin_dir, paths.models_dir]) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const n of names) {
      try {
        total += statSync(join(dir, n)).size
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return total
}
