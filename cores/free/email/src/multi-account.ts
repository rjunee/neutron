/**
 * @neutronai/email-managed-core — the MULTI-ACCOUNT Gmail client.
 *
 * An owner with more than one Google account had, until now, one connected
 * mailbox: mail to every other address was invisible to the agent. This client
 * wraps N per-account Gmail clients behind the single `GmailClient` contract,
 * so the `/email` filter, the MCP tools and the triage scheduler are unchanged.
 *
 * ── READ: fan out, then merge ──────────────────────────────────────────────────
 * `listMessages` and `search` query every account concurrently and merge:
 *
 *   1. DEDUPE by message id, first account in fan-out order winning. Gmail ids
 *      are per-account so genuine collisions are rare, but deduping first keeps
 *      "first wins" deterministic if two accounts ever do agree on an id, and
 *      costs one Set.
 *   2. SORT by `internal_date` DESCENDING — newest first, which is the ordering
 *      the single-account contract already documents and the only ordering an
 *      inbox is readable in.
 *   3. TRUNCATE to `max_results`. Each account is asked for the full count so
 *      the merged set can fill from one account when the others are quiet, and
 *      truncating last keeps the newest overall rather than the newest per
 *      account.
 *
 * Every returned message is stamped with the account it came from — without
 * that, a merged inbox cannot be triaged and a reply's from-address is a guess.
 *
 * PAGINATION across accounts is deliberately not offered: Gmail's page tokens
 * are per-account opaque cursors, and a merged cursor would have to encode one
 * per account and re-derive the merge on every page. With more than one account
 * connected, `next_page_token` is omitted rather than returned wrong — a caller
 * that needs more mail raises `max_results`. With exactly one account the
 * client is pass-through and the real cursor is returned unchanged.
 *
 * ── PARTIAL FAILURE IS NOT TOTAL FAILURE ───────────────────────────────────────
 * One expired grant must not empty the inbox. Accounts that answer are
 * returned; accounts that fail are reported through `listMessagesAcrossAccounts`
 * (and to `onAccountError`). Every account failing throws, because an empty
 * SUCCESS there is indistinguishable from "no new mail" — the exact silent
 * failure this design exists to prevent.
 *
 * ── WRITE: the primary account ─────────────────────────────────────────────────
 * `createDraft` / `sendMessage` / `ensureProjectLabel` / `modifyThread` target
 * the primary (first) account: mail has to be sent FROM one address, and the
 * account the owner has held longest is the least surprising default.
 * `getMessage` / `getThread` address an id, so they walk accounts in order
 * until one recognises it — a message in the third account still opens, and a
 * genuinely unknown id still raises the same typed not-found error.
 */

import {
  DEFAULT_LIST_LIMIT,
  type AccountReadOutcome,
  type GmailClient,
  type GmailDraftInput,
  type GmailDraftResult,
  type GmailEnsureLabelInput,
  type GmailGetInput,
  type GmailLabelEnsureInput,
  type GmailLabelEnsureResult,
  type GmailListAcrossAccounts,
  type GmailListInput,
  type GmailListResult,
  type GmailMessageFull,
  type GmailMessageMeta,
  type GmailMessageModifyInput,
  type GmailMessageModifyResult,
  type GmailSearchInput,
  type GmailSendInput,
  type GmailSendResult,
  type GmailThreadFull,
  type GmailThreadGetInput,
  type GmailThreadModifyInput,
  type GmailThreadModifyResult,
} from './contract.ts'
import {
  MessageNotFoundError,
  OAuthMissingError,
  ThreadNotFoundError,
} from './errors.ts'
import { buildGoogleGmailClient, type FetchLike } from './google-client.ts'

/**
 * One connected account, as the fan-out consumes it. Mirrors the gateway's
 * `ResolvedAccount` structurally so the composer passes its resolver straight
 * through without an adapter, while this Core stays free of a gateway import.
 */
export interface GmailAccountDescriptor {
  /** Stable id for this account. Stamped onto every message read from it. */
  account_id: string
  /** Address of this account, when known. */
  account_email: string | null
  /** Lazy per-account token accessor. Null ⇒ this account is not connected. */
  accessToken: () => Promise<string | null>
}

/**
 * Resolves the CURRENT account set. Called per request, not once at build
 * time, so an account connected (or disconnected) after boot takes effect
 * without a restart.
 */
export type GmailAccountsResolver = () => Promise<readonly GmailAccountDescriptor[]>

export interface MultiAccountGmailClientOptions {
  accounts: GmailAccountsResolver
  /** Override for tests / local dev. Forwarded to each per-account client. */
  baseUrl?: string
  /** Override fetch — forwarded to each per-account client. */
  fetchImpl?: FetchLike
  /**
   * Build the client for one account. Defaults to the Gmail REST client;
   * overridden in tests to substitute per-account fakes.
   */
  buildClient?: (account: GmailAccountDescriptor) => GmailClient
  /**
   * Notified whenever ONE account fails a fan-out read. Wired to the logger in
   * production so a degraded account is observable even on paths that only
   * consume the merged rows.
   */
  onAccountError?: (event: {
    account_id: string
    account_email: string | null
    operation: string
    error: string
  }) => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Newest-first sort key. Unparseable dates sort last rather than throwing. */
function dateInstant(row: GmailMessageMeta): number {
  const ms = Date.parse(row.internal_date)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

export function buildMultiAccountGmailClient(
  options: MultiAccountGmailClientOptions,
): GmailClient {
  const buildClient =
    options.buildClient ??
    ((account: GmailAccountDescriptor): GmailClient =>
      buildGoogleGmailClient({
        accessToken: account.accessToken,
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }))
  const notify = options.onAccountError

  /**
   * Resolve the live account set. Zero accounts means nothing is connected —
   * the same condition a null token represents on a single-account client, so
   * it raises the same `OAuthMissingError` and every caller's existing
   * "re-prompt for consent" handling keeps working unchanged.
   */
  async function accountsOrThrow(): Promise<readonly GmailAccountDescriptor[]> {
    const accounts = await options.accounts()
    if (accounts.length === 0) throw new OAuthMissingError()
    return accounts
  }

  /** The primary account's client — the target for sends and label writes. */
  async function primary(): Promise<GmailClient> {
    const accounts = await accountsOrThrow()
    // Non-null: accountsOrThrow guarantees a non-empty list.
    return buildClient(accounts[0] as GmailAccountDescriptor)
  }

  /**
   * The client for a NAMED account, or null when no connected account carries
   * that id. The pipeline stamps `account_id` onto every row it reads, so a
   * write derived from a read can address the account the message actually
   * lives in — writing it to the primary would label (or archive) nothing, or
   * worse, the wrong mailbox's message with a colliding id.
   */
  async function byAccountId(account_id: string): Promise<GmailClient | null> {
    const accounts = await accountsOrThrow()
    const match = accounts.find((a) => a.account_id === account_id)
    return match === undefined ? null : buildClient(match)
  }

  /** The account-tag fields for one account. */
  function stamp(account: GmailAccountDescriptor): {
    account_id: string
    account_email?: string
  } {
    return {
      account_id: account.account_id,
      ...(account.account_email !== null
        ? { account_email: account.account_email }
        : {}),
    }
  }

  /** Stamp the account a message was read from onto the message. */
  function tag(
    row: GmailMessageMeta,
    account: GmailAccountDescriptor,
  ): GmailMessageMeta {
    return { ...row, ...stamp(account) }
  }

  /**
   * Walk accounts in fan-out order until one recognises the id. Only the typed
   * not-found errors advance to the next account — any other error is the
   * caller's answer, because retrying a 500 elsewhere would turn one account's
   * outage into a misleading "not found".
   */
  async function byId<T>(
    run: (client: GmailClient) => Promise<T>,
  ): Promise<{ value: T; account: GmailAccountDescriptor }> {
    const accounts = await accountsOrThrow()
    let notFound: unknown = null
    for (const account of accounts) {
      try {
        return { value: await run(buildClient(account)), account }
      } catch (err) {
        if (err instanceof MessageNotFoundError || err instanceof ThreadNotFoundError) {
          notFound = err
          continue
        }
        throw err
      }
    }
    throw notFound
  }

  /** The shared fan-out + merge both read paths use. */
  async function fanOutList(
    operation: 'listMessages' | 'search',
    limit: number,
    read: (client: GmailClient) => Promise<GmailListResult>,
  ): Promise<GmailListAcrossAccounts & { next_page_token?: string }> {
    const accounts = await accountsOrThrow()
    const settled = await Promise.allSettled(accounts.map((a) => read(buildClient(a))))

    const outcomes: AccountReadOutcome[] = []
    const merged: GmailMessageMeta[] = []
    const seen = new Set<string>()
    let firstFailure: unknown = null
    let okCount = 0
    let solePageToken: string | undefined

    for (let i = 0; i < accounts.length; i++) {
      // Non-null: index-aligned with `accounts` by construction.
      const account = accounts[i] as GmailAccountDescriptor
      const result = settled[i] as PromiseSettledResult<GmailListResult>
      if (result.status === 'rejected') {
        if (firstFailure === null) firstFailure = result.reason
        const error = errorText(result.reason)
        outcomes.push({
          account_id: account.account_id,
          account_email: account.account_email,
          ok: false,
          error,
        })
        notify?.({
          account_id: account.account_id,
          account_email: account.account_email,
          operation,
          error,
        })
        continue
      }
      okCount++
      outcomes.push({
        account_id: account.account_id,
        account_email: account.account_email,
        ok: true,
      })
      // Only meaningful when exactly one account is connected; see the header.
      if (accounts.length === 1) solePageToken = result.value.next_page_token
      for (const row of result.value.results) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        merged.push(tag(row, account))
      }
    }

    // Every account failed. Returning `[]` here would be an empty SUCCESS —
    // "no new mail" and a total outage would look identical.
    if (okCount === 0 && firstFailure !== null) throw firstFailure

    merged.sort((a, b) => {
      const delta = dateInstant(b) - dateInstant(a)
      if (delta !== 0) return delta
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return {
      results: merged.slice(0, limit),
      accounts: outcomes,
      ...(solePageToken !== undefined ? { next_page_token: solePageToken } : {}),
    }
  }

  async function listMessagesAcrossAccounts(
    input: GmailListInput,
  ): Promise<GmailListAcrossAccounts> {
    const max_results = input.max_results ?? DEFAULT_LIST_LIMIT
    return await fanOutList('listMessages', max_results, (client) =>
      client.listMessages({ ...input, max_results }),
    )
  }

  return {
    listMessagesAcrossAccounts,
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      const max_results = input.max_results ?? DEFAULT_LIST_LIMIT
      const out = await fanOutList('listMessages', max_results, (client) =>
        client.listMessages({ ...input, max_results }),
      )
      return {
        results: out.results,
        ...(out.next_page_token !== undefined
          ? { next_page_token: out.next_page_token }
          : {}),
      }
    },
    async search(input: GmailSearchInput): Promise<GmailListResult> {
      const max_results = input.max_results ?? DEFAULT_LIST_LIMIT
      const out = await fanOutList('search', max_results, (client) =>
        client.search({ ...input, max_results }),
      )
      return {
        results: out.results,
        ...(out.next_page_token !== undefined
          ? { next_page_token: out.next_page_token }
          : {}),
      }
    },
    async getMessage(input: GmailGetInput): Promise<GmailMessageFull> {
      const { value, account } = await byId((client) => client.getMessage(input))
      return { ...value, ...stamp(account) }
    },
    async getThread(input: GmailThreadGetInput): Promise<GmailThreadFull> {
      const { value, account } = await byId((client) => client.getThread(input))
      return {
        ...value,
        messages: value.messages.map((m) => ({ ...m, ...stamp(account) })),
      }
    },
    async createDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
      return await (await primary()).createDraft(input)
    },
    async sendMessage(input: GmailSendInput): Promise<GmailSendResult> {
      return await (await primary()).sendMessage(input)
    },
    async ensureProjectLabel(
      input: GmailLabelEnsureInput,
    ): Promise<GmailLabelEnsureResult> {
      return await (await primary()).ensureProjectLabel(input)
    },
    async ensureLabel(input: GmailEnsureLabelInput): Promise<GmailLabelEnsureResult> {
      // A label id is per-account, so the pipeline ensures the processed label
      // once PER ACCOUNT and passes the account it is about to write to.
      const targeted =
        input.account_id !== undefined ? await byAccountId(input.account_id) : null
      return await (targeted ?? (await primary())).ensureLabel(input)
    },
    async modifyThread(
      input: GmailThreadModifyInput,
    ): Promise<GmailThreadModifyResult> {
      return await (await primary()).modifyThread(input)
    },
    async modifyMessage(
      input: GmailMessageModifyInput,
    ): Promise<GmailMessageModifyResult> {
      const targeted =
        input.account_id !== undefined ? await byAccountId(input.account_id) : null
      if (targeted !== null) return await targeted.modifyMessage(input)
      // No account named (or an id no longer connected): fall back to the
      // by-id probe — the same walk `getMessage` uses, so a message in the
      // third account is still labelled rather than 404-ing against the first.
      const { value } = await byId((client) => client.modifyMessage(input))
      return value
    },
  }
}
