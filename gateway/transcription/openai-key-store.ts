/**
 * @neutronai/gateway/transcription — the owner's OpenAI transcription API key.
 *
 * Storage for the one secret this subsystem needs, following the convention the
 * Codex subscription bundle already established (`trident/codex-credential.ts`):
 * the plaintext goes into the AES-256-GCM `ProjectCredentialStore` (migration
 * 0092, encrypted under the shared `.neutron-aes-key`) at GLOBAL scope, under a
 * reserved service name. Transcription is machine-scoped — one setting serves
 * every project on the box — so there is no per-project override here.
 *
 * ── The key is WRITE-ONLY ───────────────────────────────────────────────────
 * `status()` returns whether a key exists, where it came from and when it was
 * saved. It NEVER returns the key, and never a masked or fingerprinted slice of
 * it either: this repo's convention is to OMIT secret material from responses
 * rather than to partially reveal it (`landing/chat-react/codex-credential-client.ts`
 * — "the stored tokens are never returned, only the status"). A last-four
 * preview would buy a little reassurance at the cost of putting key material in
 * an HTTP body, a browser devtools pane, and every proxy log in between; "a key
 * was saved at 21:04" answers the same question without any of that. Nothing in
 * this module logs the key, and the plaintext is read only at the moment a
 * transcription client is constructed.
 *
 * ── Two sources, one resolution ─────────────────────────────────────────────
 * A key can come from the store OR from `OPENAI_API_KEY` in the server's
 * environment — which is how every box got one before this surface existed, and
 * a self-hoster who already has it in `.env` should not have to paste it again.
 * The store wins when both are present (it is the more deliberate act, and it is
 * the one the owner can change from a phone). WHICH source supplied the key is
 * reported to the UI, because "the key came from your server's environment, not
 * from anything you typed here" is exactly the sort of thing that is baffling
 * when hidden.
 *
 * Note the environment variable is shared with the conversational OpenAI pool
 * and the embeddings backfill, so its mere presence never used to be safe to
 * read as "the owner wants OpenAI transcription". It still isn't — but that
 * question is now answered by the SETTING (`instance_metadata.transcription_backend`),
 * not by which credentials happen to exist. This module only answers "is there a
 * key, and where from".
 */

import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'

/** The reserved `project_credentials.service` name for the transcription key. */
export const OPENAI_TRANSCRIPTION_SERVICE = 'openai_transcription'

/**
 * A deliberately distinct service name rather than a shared `openai` row.
 *
 * A generic `openai` credential would be read by whatever else wanted an OpenAI
 * key, so pasting a key for one purpose would silently switch on another — the
 * same class of surprise as the precedence rule this feature removes. One
 * name, one purpose, visible as its own row in Settings → Credentials.
 */

/** Where a resolved key came from. `null` when there is no key at all. */
export type OpenAiKeySource = 'stored' | 'environment'

export interface OpenAiKeyStatus {
  present: boolean
  source: OpenAiKeySource | null
  /** ISO-8601 timestamp of the last save. Only set for `source: 'stored'`. */
  saved_at: string | null
}

export interface OpenAiKeyStoreDeps {
  store: ProjectCredentialStore
  owner_slug: OwnerHandle
  env: Record<string, string | undefined>
}

/**
 * Longest key we will accept. OpenAI keys are ~50-200 chars; the credential
 * store's own cap is 8192. This tighter bound rejects an obvious paste error
 * (a whole file, a curl command) at the surface instead of storing it.
 */
export const MAX_OPENAI_KEY_LEN = 512

/** Why a pasted key was refused, or `null` when it is acceptable. */
export function validateOpenAiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'the key must be a string'
  const key = raw.trim()
  if (key.length === 0) return 'the key is empty'
  if (key.length > MAX_OPENAI_KEY_LEN) {
    return `the key is ${key.length} characters — that is longer than any OpenAI key; check what was pasted`
  }
  // Whitespace INSIDE the key is always a paste accident (a wrapped line, a
  // copied shell command). Catching it here turns a baffling 401 at the moment
  // a voice note is sent into an immediate, legible rejection.
  if (/\s/.test(key)) return 'the key contains a space or line break — paste the key on its own'
  return null
}

export class OpenAiKeyStore {
  private readonly store: ProjectCredentialStore
  private readonly owner_slug: OwnerHandle
  private readonly env: Record<string, string | undefined>

  constructor(deps: OpenAiKeyStoreDeps) {
    this.store = deps.store
    this.owner_slug = deps.owner_slug
    this.env = deps.env
  }

  /** Presence + provenance. Never the key. */
  status(): OpenAiKeyStatus {
    const meta = this.store.getMeta(this.owner_slug, '', OPENAI_TRANSCRIPTION_SERVICE)
    if (meta !== null) {
      return { present: true, source: 'stored', saved_at: meta.updated_at }
    }
    if (this.envKey() !== null) return { present: true, source: 'environment', saved_at: null }
    return { present: false, source: null, saved_at: null }
  }

  /**
   * The plaintext key, or `null` when none is configured. The ONLY caller is the
   * transcriber resolver, at the moment it constructs the hosted client.
   */
  resolve(): string | null {
    const stored = this.store.resolve(this.owner_slug, '', OPENAI_TRANSCRIPTION_SERVICE)
    if (stored !== null && stored.plaintext.trim().length > 0) return stored.plaintext.trim()
    return this.envKey()
  }

  /** Store (or replace) the key. Trimmed; validated by the caller. */
  async save(plaintext: string): Promise<void> {
    await this.store.set(this.owner_slug, {
      service: OPENAI_TRANSCRIPTION_SERVICE,
      plaintext: plaintext.trim(),
      scope: 'global',
      label: 'Voice-note transcription',
    })
  }

  /**
   * Delete the stored key. Returns whether a row was removed.
   *
   * This CANNOT unset an environment key — that lives in the server's `.env` or
   * unit file, which no HTTP request should be able to rewrite. The surface says
   * so rather than reporting a delete that leaves the box still credentialed.
   */
  async remove(): Promise<boolean> {
    return await this.store.delete(this.owner_slug, '', OPENAI_TRANSCRIPTION_SERVICE)
  }

  private envKey(): string | null {
    const key = (this.env['OPENAI_API_KEY'] ?? '').trim()
    return key.length > 0 ? key : null
  }
}
