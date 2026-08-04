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
 * ── Three sources, one resolution ───────────────────────────────────────────
 * A key can come from THIS surface's dedicated row, from the general OpenAI
 * credential the owner already pasted for semantic memory, or from
 * `OPENAI_API_KEY` in the server's environment — which is how every box got one
 * before this surface existed, and a self-hoster who already has it in `.env`
 * should not have to paste it again. They are tried in that order (see
 * `resolve()`); WHICH one supplied the key is reported to the UI, because "the
 * key came from your server's environment, not from anything you typed here" is
 * exactly the sort of thing that is baffling when hidden.
 *
 * Note the environment variable is shared with the conversational OpenAI pool
 * and the embeddings backfill, so its mere presence never used to be safe to
 * read as "the owner wants OpenAI transcription". It still isn't — but that
 * question is now answered by the SETTING (`instance_metadata.transcription_backend`),
 * not by which credentials happen to exist. That separation is what lets the
 * KEY be shared without the FEATURE switching itself on: having a key means
 * transcription CAN run, never that it will. This module only answers "is there
 * a key, and where from".
 */

import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'

/** The reserved `project_credentials.service` name for the transcription key. */
export const OPENAI_TRANSCRIPTION_SERVICE = 'openai_transcription'

/**
 * Its own row, but NOT its own key requirement — the dedicated name is an
 * OPTIONAL override, not a second key the owner has to supply.
 *
 * This name used to be justified as an isolation boundary: a generic OpenAI
 * credential would be read by whatever else wanted an OpenAI key, so pasting a
 * key for one purpose would silently switch on another. That reasoning is
 * RETIRED — it protects a user from a bill they did not choose, and Neutron has
 * no such user. There is one owner, he pastes his own key, and he knows what he
 * is paying for; making him paste the same secret a second time to make voice
 * notes work reads as a bug, not as a safeguard. (SPEC § Decisions Log
 * 2026-08-04 — "ONE OpenAI key serves EVERY OpenAI-backed feature".)
 *
 * So the contract is a resolution ORDER, not an isolation rule — see
 * `resolve()`. The dedicated row still exists and still wins, which is what
 * anyone who DOES want transcription spend on a separate key reaches for; it is
 * simply no longer the only row that counts.
 */

/**
 * Where a resolved key came from. `null` when there is no key at all.
 *
 * `shared` is the general OpenAI credential — the one the onboarding offer and
 * Settings → Integrations write, which also powers semantic-memory embeddings.
 * It is reported distinctly from `stored` because "the key you saved for
 * something else is being used here too" is exactly the sort of thing that is
 * baffling when hidden, and because deleting the transcription key does not
 * remove it.
 */
export type OpenAiKeySource = 'stored' | 'shared' | 'environment'

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
  /**
   * Reads the GENERAL OpenAI credential — the one the onboarding optional-key
   * offer and Settings → Integrations write. Resolves to `null`/`undefined`
   * when the owner never saved one.
   *
   * A thunk, and a REQUIRED one. It is a thunk because that credential lives in
   * a DIFFERENT store — `ApiKeyStore` over `SecretsStore` (tables `api_keys` +
   * `secrets`), keyed by `provider='openai', label='onboarding'` — not in the
   * `project_credentials` table this class otherwise talks to, and reaching it
   * needs a `ProjectDb` + the owner's data dir that this module has no business
   * holding. `gateway/wiring/resolve-onboarding-openai-key.ts` is the canonical
   * reader; production passes it here, exactly as the GBrain embedder wiring
   * already does. It is required rather than optional so a construction site
   * cannot quietly omit the fallback and reintroduce the bug this closes.
   */
  resolveSharedKey: () => Promise<string | null | undefined>
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
  private readonly resolveSharedKey: () => Promise<string | null | undefined>

  constructor(deps: OpenAiKeyStoreDeps) {
    this.store = deps.store
    this.owner_slug = deps.owner_slug
    this.env = deps.env
    this.resolveSharedKey = deps.resolveSharedKey
  }

  /**
   * Presence + provenance. Never the key.
   *
   * Walks the SAME order as `resolve()` — deliberately, and it is the reason
   * this is worth stating: if the two ever disagree, Settings reports "no key"
   * while voice notes transcribe fine (or the reverse), and the owner is left
   * debugging a panel that is lying to him. Anything added to one goes in the
   * other, in the same position.
   */
  async status(): Promise<OpenAiKeyStatus> {
    const meta = this.store.getMeta(this.owner_slug, '', OPENAI_TRANSCRIPTION_SERVICE)
    if (meta !== null) {
      return { present: true, source: 'stored', saved_at: meta.updated_at }
    }
    if ((await this.sharedKey()) !== null) {
      // No `saved_at`: that timestamp belongs to the Integrations row, not to
      // anything saved here, and dating this panel with it would imply the key
      // is this panel's to manage — it is not, and DELETE would not remove it.
      return { present: true, source: 'shared', saved_at: null }
    }
    if (this.envKey() !== null) return { present: true, source: 'environment', saved_at: null }
    return { present: false, source: null, saved_at: null }
  }

  /**
   * The plaintext key, or `null` when none is configured. The ONLY callers are
   * the transcriber resolver (at the moment it constructs the hosted client)
   * and the status surface.
   *
   * ── The resolution order ────────────────────────────────────────────────
   *   1. the DEDICATED row (`openai_transcription`, this surface's own),
   *   2. the SHARED credential (`ApiKeyStore` provider=openai/label=onboarding
   *      — the semantic-memory key),
   *   3. `OPENAI_API_KEY` from the server environment.
   *
   * One key works everywhere by DEFAULT — step 2 is what makes the key the
   * owner pasted for semantic search also transcribe his voice notes, without
   * him pasting it twice. A separate key still scopes transcription spend for
   * anyone who wants that, because step 1 outranks it.
   *
   * Order, not a branch: each step is tried and the first non-empty answer
   * wins. There is no mode, no flag, and no second code path — a box with only
   * a shared key and a box with both take the identical route through this
   * function and differ only in which step returns first.
   */
  async resolve(): Promise<string | null> {
    const stored = this.store.resolve(this.owner_slug, '', OPENAI_TRANSCRIPTION_SERVICE)
    if (stored !== null && stored.plaintext.trim().length > 0) return stored.plaintext.trim()
    const shared = await this.sharedKey()
    if (shared !== null) return shared
    return this.envKey()
  }

  /**
   * The general OpenAI credential, trimmed, or `null`.
   *
   * Best-effort by contract, mirroring `resolveOnboardingOpenAiKey`: a store
   * that throws must not take out voice transcription (or, worse, the status
   * GET that renders the whole Settings panel) — it degrades to the next source
   * in the order. Nothing about the failure is logged HERE because the
   * canonical reader already warns with the owner + error, and a second log
   * line at this layer would be the only place in this module that touches a
   * path holding key material.
   */
  private async sharedKey(): Promise<string | null> {
    try {
      const key = (await this.resolveSharedKey()) ?? ''
      const trimmed = key.trim()
      return trimmed.length > 0 ? trimmed : null
    } catch {
      return null
    }
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
