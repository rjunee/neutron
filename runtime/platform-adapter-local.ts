/**
 * @neutronai/runtime — LocalPlatformAdapter (Open / single-instance stub).
 *
 * Sprint B (2026-05-17). Open self-hosted single-instance tier:
 *   - One user, one owner, one Telegram bot (BotFather-issued by the
 *     user; not provisioned by Neutron).
 *   - No Caddy, no sudoers, no `/srv/neutron`, no slug-rename
 *     machinery, no identity-service-network-call.
 *   - The "owner" is whoever invoked `bun start`; the Open boot shell
 *     constructs this adapter with the single instance's `internal_handle`
 *     + `url_slug` + `owner_home` baked in.
 *
 * Managed-only operations (slug-rename, install-token, connect
 * fan-out, manager-bot provisioning, Caddy reload, sudoers regenerate)
 * all throw `PlatformOperationUnsupportedError`. The capability flags
 * advertise these as `false` so well-written boot shells never invoke
 * them; the throw is the defense-in-depth backstop against a caller
 * that bypasses the capability check.
 *
 * Operations that are semantically valid on a single-instance box —
 * instance lookup, slug grammar/availability probe, the standard
 * Anthropic Max OAuth handshake — are implemented in-process here.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'

import { sanitizeToSlug, type SlugAvailability } from './slug-grammar.ts'
import {
  PlatformOperationUnsupportedError,
  type ConnectCallInput,
  type ConnectCallResult,
  type GenerateProjectBackupKeypairResult,
  type InstallTokenInput,
  type InstallTokenResult,
  type ManagedOnlyPlatformOp,
  type OAuthHandoffInput,
  type OAuthHandoffResult,
  type PlatformAdapter,
  type PlatformCapabilities,
  type PlatformInstanceInfo,
  type ProjectBackupRemoteConfig,
  type ProvisionManagerBotInput,
  type ProvisionManagerBotResult,
  type RenameSlugInput,
  type RenameSlugResult,
  type SetProjectBackupRemoteConfigInput,
  type SlugAvailabilityProbe,
} from './platform-adapter.ts'
import type { OnboardingPhase } from '../onboarding/interview/phase.ts'

const execFileAsync = promisify(execFile)

/**
 * Inputs to construct a `LocalPlatformAdapter`. The boot shell bakes
 * the single instance's identity in at construction so every instance-
 * lookup call is a pure in-memory match against this row.
 */
export interface LocalPlatformAdapterInput {
  /**
   * The single local instance. Sprint B keeps the shape structural; Sprint D
   * (Open install + clean-VM smoke test) will land the resolver that
   * builds this row from `NEUTRON_HOME` + env defaults.
   */
  selfOwner: PlatformInstanceInfo
  /**
   * Optional OAuth handoff hook. The Open self-hosted Anthropic Max
   * OAuth handshake is a runtime concern, not a platform one — Sprint
   * B leaves the implementation to the boot shell that wires this
   * adapter. When omitted (the common case for unit tests + Sprint B
   * integration test), `oauthHandoff(...)` throws
   * `PlatformOperationUnsupportedError('oauthHandoff')` so the absence
   * is observable and not silently degraded.
   */
  oauthHandoff?: (input: OAuthHandoffInput) => Promise<OAuthHandoffResult>
  /**
   * Absolute path to the Neutron repo root that hosts the public
   * `cores/free/*` tree. The bundled-Cores registry walks
   * `<publicRoot>/cores/<container>/<core>/` at boot. P3 boot shell on
   * Open passes the locally-cloned repo path; tests pass a fixture
   * dir. Omitting it falls back to `process.cwd()` so legacy callers
   * (unit tests that never invoke the Cores composer) keep working.
   */
  publicRoot?: string
  /**
   * P7.4 Phase 2 — per-instance secrets dir where per-project SSH keys
   * live (mode 0600). Production wires `<owner_home>/.secrets/`;
   * tests pass a temp dir. Defaults to `<selfOwner.owner_home>/.secrets`.
   */
  secretsDir?: string
  /**
   * P7.4 Phase 2 — override project-root resolver for the project-
   * backup remote-config file. Production: `<owner_home>/Projects/<id>`.
   * Tests can pass a fixture root.
   */
  resolveProjectRoot?: (project_id: string) => string
  /**
   * P7.4 Phase 2 — override `ssh-keygen` invocation. Tests can stub
   * this to avoid spawning the real binary.
   */
  sshKeygen?: (args: string[]) => Promise<{ stdout: string; stderr: string }>
  /** P7.4 Phase 2 — now-fn for tests. */
  now?: () => number
}

const LOCAL_CAPABILITIES: PlatformCapabilities = {
  slug_rename: false,
  install_token_mint: false,
  connect_fanout: false,
  manager_bot_provisioning: false,
  caddy_reload: false,
  sudoers_regenerate: false,
  tier_two_cores: false,
  // Open advertises project-backup support — local backups always
  // work (the scheduler runs in-process); remote push is gated on
  // the user wiring a remote via the admin UI.
  project_backup: true,
  // Sprint B (2026-05-20) — Open never runs the Managed signup-recover
  // / start-token / internal-signature / connect chains. Every
  // optional hook is omitted on Local; the capability flags stay false
  // so well-written boot shells never invoke the corresponding methods.
  signup_recover: false,
  start_token_verify: false,
  internal_signature: false,
  connect_api: false,
}

/** Per-project remote-config filename written under each project root. */
const PROJECT_BACKUP_REMOTE_CONFIG = '.project-backup-remote.json'
/** Per-project SSH key filename prefix under `<owner_home>/.secrets/`. */
const PROJECT_BACKUP_KEY_PREFIX = 'project-backup-key-'
/** SSH-shape grammar for v1 remotes (HTTPS rejected). */
const SSH_REMOTE_URL_RE = /^git@[a-zA-Z0-9.-]+:[\w./-]+(\.git)?$/
/** Generate-keypair pending-key TTL — 10 minutes. */
const GENERATED_KEY_TTL_MS = 10 * 60 * 1000

interface PendingKeypair {
  request_id: string
  private_pem: string
  public_key: string
  expires_at_ms: number
}

/**
 * The Managed-tier operations a single-instance Open box cannot perform. They
 * are present on the adapter (so it satisfies `PlatformAdapter`) but every one
 * throws `PlatformOperationUnsupportedError` — the defense-in-depth backstop for
 * a caller that bypassed the `capabilities.<X>` check. Centralized into ONE
 * typed unit (`ManagedOnlyPlatformOp`) per the Open-core/Managed-extension split
 * (audit §0 item 5 / Q5) so the unsupported surface isn't a scatter of inline
 * stubs across the live-behavior methods.
 */
function buildUnsupportedManagedOps(): Pick<PlatformAdapter, ManagedOnlyPlatformOp> {
  return {
    async renameSlug(_input: RenameSlugInput): Promise<RenameSlugResult> {
      throw new PlatformOperationUnsupportedError(
        'renameSlug',
        'Slug rename is a Managed-tier orchestration; Open self-hosted owners change their slug by restarting with NEUTRON_INSTANCE_SLUG=<new>',
      )
    },

    async mintInstallToken(_input: InstallTokenInput): Promise<InstallTokenResult> {
      throw new PlatformOperationUnsupportedError(
        'mintInstallToken',
        'Install-token mint depends on a hosted auth service which Open self-hosted boxes do not run',
      )
    },

    async connectCall(_input: ConnectCallInput): Promise<ConnectCallResult> {
      throw new PlatformOperationUnsupportedError(
        'connectCall',
        'Connect fan-out requires the instance ↔ instance origin-tagged HTTPS API which Open single-instance boxes do not run',
      )
    },

    async provisionManagerBot(
      _input: ProvisionManagerBotInput,
    ): Promise<ProvisionManagerBotResult> {
      throw new PlatformOperationUnsupportedError(
        'provisionManagerBot',
        'Open self-hosted owners register their own Telegram bot with BotFather; manager-bot auto-provisioning is a Managed-tier orchestration',
      )
    },

    async reloadCaddy(): Promise<void> {
      throw new PlatformOperationUnsupportedError(
        'reloadCaddy',
        'Open self-hosted boxes do not run a Caddy reverse-proxy layer; users supply their own DNS + TLS termination',
      )
    },

    async regenerateSudoers(): Promise<void> {
      throw new PlatformOperationUnsupportedError(
        'regenerateSudoers',
        'Open self-hosted boxes do not run Managed-tier systemd units; the user supervises their own process',
      )
    },
  }
}

/**
 * Build a single-instance Open platform adapter. The boot shell on a
 * self-hosted Neutron Open box constructs this once at boot, threads it
 * into `gateway/composition.ts:composeProductionGraph({ ..., platform })`,
 * and never touches it directly after — every consumer accesses the
 * adapter through the `PlatformAdapter` interface.
 *
 * The Sprint B integration test (`tests/integration/local-platform-
 * adapter-boot.test.ts`) walks the M2 onboarding fixture against this
 * adapter to prove the byte-identical emit sequence + phase transitions
 * gate.
 */
export function buildLocalPlatformAdapter(
  input: LocalPlatformAdapterInput,
): PlatformAdapter {
  const selfOwner = input.selfOwner
  const oauthHook = input.oauthHandoff
  const publicRoot = input.publicRoot ?? process.cwd()
  const secretsDir = input.secretsDir ?? join(selfOwner.owner_home, '.secrets')
  const resolveProjectRoot =
    input.resolveProjectRoot ??
    ((project_id: string): string =>
      join(selfOwner.owner_home, 'Projects', project_id))
  const sshKeygen =
    input.sshKeygen ??
    (async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      const { stdout, stderr } = await execFileAsync('ssh-keygen', args, {
        encoding: 'utf8',
      })
      return {
        stdout: typeof stdout === 'string' ? stdout : String(stdout),
        stderr: typeof stderr === 'string' ? stderr : String(stderr),
      }
    })
  const nowFn = input.now ?? ((): number => Date.now())
  /** Pending generated keys; per-project to allow concurrent flows. */
  const pendingKeypairs = new Map<string, PendingKeypair>()
  const slugAvailability: SlugAvailabilityProbe = {
    /**
     * Open single-instance: every grammar-legal slug is available
     * (there's no other instance to conflict against, no slug-history,
     * no reserved-set). Invalid grammar still returns
     * `{available:false, reason:'invalid_format'}` so the engine's
     * `slug_chosen` resolver still distinguishes "bad input" from
     * "available" — the user-facing branch remains stable across tiers.
     */
    check(probeInput): SlugAvailability {
      const sanitized = sanitizeToSlug(probeInput.slug)
      if (sanitized === null || sanitized !== probeInput.slug) {
        return { slug: probeInput.slug, available: false, reason: 'invalid_format' }
      }
      return { slug: probeInput.slug, available: true, reason: null }
    },
    sanitize: sanitizeToSlug,
  }

  return {
    capabilities: LOCAL_CAPABILITIES,
    slugAvailability,

    resolveOwnerBySlug(url_slug: string): PlatformInstanceInfo | null {
      if (url_slug === selfOwner.url_slug) return selfOwner
      return null
    },

    resolveOwnerByInternalHandle(internal_handle: string): PlatformInstanceInfo | null {
      if (internal_handle === selfOwner.internal_handle) return selfOwner
      return null
    },

    // Managed-tier orchestrations — every one throws on Open (single typed
    // unit; see buildUnsupportedManagedOps + ManagedOnlyPlatformOp).
    ...buildUnsupportedManagedOps(),

    async oauthHandoff(input: OAuthHandoffInput): Promise<OAuthHandoffResult> {
      if (oauthHook === undefined) {
        throw new PlatformOperationUnsupportedError(
          'oauthHandoff',
          'LocalPlatformAdapter was constructed without an oauthHandoff hook; supply one to enable Anthropic Max OAuth on Open self-hosted boxes',
        )
      }
      return oauthHook(input)
    },

    getBundledCoreRoots(): readonly string[] {
      // Open returns a single-element array — the public repo root.
      // Tier 2 `@neutron-paid/*` Cores are not installable on Open; the
      // Sprint C repo split moves the managed root behind the Managed
      // adapter only.
      return [publicRoot] as const
    },

    async getProjectBackupRemoteConfig(
      project_id: string,
    ): Promise<ProjectBackupRemoteConfig | null> {
      const path = projectRemoteConfigPath(resolveProjectRoot, project_id)
      try {
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Partial<ProjectBackupRemoteConfig>
        if (
          typeof parsed.remote_url !== 'string' ||
          typeof parsed.ssh_key_path !== 'string' ||
          (parsed.source !== 'managed_provisioned' &&
            parsed.source !== 'user_connected') ||
          typeof parsed.configured_at !== 'string'
        ) {
          return null
        }
        return {
          remote_url: parsed.remote_url,
          ssh_key_path: parsed.ssh_key_path,
          source: parsed.source,
          configured_at: parsed.configured_at,
        }
      } catch {
        return null
      }
    },

    async setProjectBackupRemoteConfig(
      project_id: string,
      reqInput: SetProjectBackupRemoteConfigInput,
    ): Promise<ProjectBackupRemoteConfig> {
      if (typeof reqInput.remote_url !== 'string' || reqInput.remote_url.length === 0) {
        throw new Error('remote_url is required')
      }
      if (!SSH_REMOTE_URL_RE.test(reqInput.remote_url)) {
        throw new Error(
          `remote_url must be SSH-shape (git@host:owner/repo.git); HTTPS not supported in v1`,
        )
      }
      // Resolve the private key — either user-supplied PEM (Path A)
      // or a pending generated keypair (Path B).
      let privatePem: string
      if (reqInput.generated_key_request_id !== undefined) {
        const pending = pendingKeypairs.get(reqInput.generated_key_request_id)
        if (pending === undefined || pending.expires_at_ms < nowFn()) {
          pendingKeypairs.delete(reqInput.generated_key_request_id)
          throw new Error('generated_key_request_id is unknown or expired')
        }
        privatePem = pending.private_pem
        pendingKeypairs.delete(reqInput.generated_key_request_id)
      } else if (typeof reqInput.ssh_key_pem === 'string') {
        privatePem = reqInput.ssh_key_pem
      } else {
        throw new Error('either ssh_key_pem or generated_key_request_id must be supplied')
      }
      // Validate the key parses via ssh-keygen.
      await validateSshKey(privatePem, sshKeygen)
      // Persist the key + config.
      const keyPath = projectKeyPath(secretsDir, project_id)
      await mkdir(secretsDir, { recursive: true, mode: 0o700 })
      const keyTmp = `${keyPath}.tmp`
      await writeFile(keyTmp, privatePem.endsWith('\n') ? privatePem : `${privatePem}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await chmod(keyTmp, 0o600)
      await rename(keyTmp, keyPath)
      const config: ProjectBackupRemoteConfig = {
        remote_url: reqInput.remote_url,
        ssh_key_path: keyPath,
        source: 'user_connected',
        configured_at: new Date(nowFn()).toISOString(),
      }
      const configPath = projectRemoteConfigPath(resolveProjectRoot, project_id)
      await mkdir(resolveProjectRoot(project_id), { recursive: true })
      const configTmp = `${configPath}.tmp`
      await writeFile(configTmp, JSON.stringify(config, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(configTmp, configPath)
      return config
    },

    async clearProjectBackupRemoteConfig(project_id: string): Promise<void> {
      const configPath = projectRemoteConfigPath(resolveProjectRoot, project_id)
      const keyPath = projectKeyPath(secretsDir, project_id)
      // Read the existing config to verify the key path matches — we
      // don't want to wipe an unrelated file if the config is stale.
      try {
        const raw = await readFile(configPath, 'utf8')
        const parsed = JSON.parse(raw) as Partial<ProjectBackupRemoteConfig>
        if (typeof parsed.ssh_key_path === 'string') {
          // Delete whatever key the config pointed at — even if it's
          // not the canonical path (a user-supplied PEM was written
          // to the canonical location regardless, but be defensive).
          try {
            await unlink(parsed.ssh_key_path)
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* config may already be gone; fall through to canonical unlinks */
      }
      try {
        await unlink(configPath)
      } catch {
        /* ignore */
      }
      try {
        await unlink(keyPath)
      } catch {
        /* ignore */
      }
    },

    async generateProjectBackupKeypair(
      project_id: string,
    ): Promise<GenerateProjectBackupKeypairResult> {
      // ssh-keygen writes to a temp path; we read the PEM + .pub back,
      // wrap them into a pending-keypair record, and return the
      // public key + request_id to the caller. The private PEM stays
      // in-memory until `setProjectBackupRemoteConfig` commits it.
      // mkdtemp atomically creates a unique directory so concurrent
      // calls cannot collide on a shared path.
      const stagingDir = await mkdtemp(
        join(tmpdir(), 'neutron-project-backup-keygen-'),
      )
      const stagedKey = join(stagingDir, 'key')
      try {
        await sshKeygen([
          '-t', 'ed25519',
          '-N', '',
          '-C', `neutron-project-backup-${project_id}@${selfOwner.url_slug}`,
          '-f', stagedKey,
        ])
        const [privatePem, publicKey] = await Promise.all([
          readFile(stagedKey, 'utf8'),
          readFile(`${stagedKey}.pub`, 'utf8'),
        ])
        const request_id = `gen_${randomBytes(16).toString('hex')}`
        const expires_at_ms = nowFn() + GENERATED_KEY_TTL_MS
        pendingKeypairs.set(request_id, {
          request_id,
          private_pem: privatePem,
          public_key: publicKey.trim(),
          expires_at_ms,
        })
        // Schedule cleanup so an unused pending key doesn't leak.
        setTimeout(() => {
          const stale = pendingKeypairs.get(request_id)
          if (stale !== undefined && stale.expires_at_ms <= nowFn()) {
            pendingKeypairs.delete(request_id)
          }
        }, GENERATED_KEY_TTL_MS + 1_000)
        return {
          request_id,
          public_key: publicKey.trim(),
          expires_at_ms,
        }
      } finally {
        try {
          await rm(stagingDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/** Resolve the per-project remote-config JSON path. */
function projectRemoteConfigPath(
  resolveProjectRoot: (project_id: string) => string,
  project_id: string,
): string {
  return join(resolveProjectRoot(project_id), PROJECT_BACKUP_REMOTE_CONFIG)
}

/** Resolve the per-project SSH private key path under <secrets>/. */
function projectKeyPath(secretsDir: string, project_id: string): string {
  return join(secretsDir, `${PROJECT_BACKUP_KEY_PREFIX}${shortHash(project_id)}`)
}

/** Compute a short stable hash for the project_id-keyed filename. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

/** Validate a PEM-encoded SSH key by piping it through ssh-keygen. */
async function validateSshKey(
  privatePem: string,
  sshKeygen: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void> {
  // Write to a temp file (ssh-keygen needs a path, not stdin) — we
  // could also call ssh-keygen -y -P '' -f <path>; the trick is that
  // the file must exist with 0600.
  const dir = join(tmpdir(), `neutron-key-validate-${randomBytes(8).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'key')
  try {
    await writeFile(path, privatePem.endsWith('\n') ? privatePem : `${privatePem}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(path, 0o600)
    try {
      await sshKeygen(['-y', '-P', '', '-f', path])
    } catch (err) {
      throw new Error(
        `ssh_key_pem failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } finally {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// Keep linter from complaining if existsSync ends up unused later.
void existsSync
