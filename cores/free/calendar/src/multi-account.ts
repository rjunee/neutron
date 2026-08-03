/**
 * @neutronai/calendar-core — the MULTI-ACCOUNT calendar client.
 *
 * An owner with more than one Google account had, until now, one connected
 * account and therefore one calendar: every other account's meetings were
 * simply invisible. This client wraps N per-account Google clients behind the
 * single `CalendarClient` contract, so nothing downstream — the `/cal` filter,
 * the MCP tools, the pre-meeting-brief scheduler — needs to know how many
 * accounts exist.
 *
 * ── READ: fan out, then merge ──────────────────────────────────────────────────
 * `list` queries every account concurrently and merges. The merge rule, in
 * order, and why each step is where it is:
 *
 *   1. DEDUPE by event id, first account in fan-out order winning. Google gives
 *      every attendee's copy of an invitation the SAME event id, so an owner
 *      invited on two of their own accounts would otherwise see one meeting
 *      twice. Deduping BEFORE the sort is what makes "first wins" deterministic
 *      rather than dependent on which copy happened to sort earlier.
 *   2. SORT by start instant ascending, ties broken by event id. A merged
 *      agenda is only useful in time order, and comparing by INSTANT (not
 *      string) keeps accounts on different calendar timezones interleaved
 *      correctly.
 *   3. TRUNCATE to `limit`. Each account is asked for the full `limit` so the
 *      merged set can be filled entirely from one account when the others are
 *      quiet, and truncation happens last so the rows kept are the earliest
 *      overall rather than the earliest per account.
 *
 * Every returned row is stamped with the account it came from.
 *
 * ── PARTIAL FAILURE IS NOT TOTAL FAILURE ───────────────────────────────────────
 * One expired grant must not blank the whole morning. Accounts that answer are
 * returned; accounts that fail are reported through `listAcrossAccounts` (and
 * to `onAccountError`) so the owner is told which calendar is missing instead
 * of silently seeing a short day. The one case that is NOT partial is every
 * account failing — that throws, because returning `[]` there would be an empty
 * SUCCESS, indistinguishable from a genuinely clear schedule, which is the
 * failure mode this whole design exists to avoid.
 *
 * ── WRITE: the primary account ─────────────────────────────────────────────────
 * `create` targets the primary (first) account — a write has to pick one, and
 * the account the owner has held longest is the least surprising default.
 * `get` / `update` / `cancel` / `invite` address an event by id, so they walk
 * accounts in order until one recognises the id: an id that belongs to the
 * third account still resolves, and a genuinely unknown id still raises
 * `EventNotFoundError` exactly as a single-account client would. `freebusy` and
 * `findTime` query OTHER people's availability, which any one valid token can
 * do, so they use the primary account rather than repeating the same question
 * N times.
 */

import {
  buildGoogleCalendarClient,
  DEFAULT_LIST_LIMIT,
  EventNotFoundError,
  OAuthMissingError,
  type AccountReadOutcome,
  type BusyInterval,
  type CalendarCancelInput,
  type CalendarClient,
  type CalendarCreateInput,
  type CalendarEventRow,
  type CalendarGetInput,
  type CalendarListAcrossAccounts,
  type CalendarListInput,
  type CalendarUpdateInput,
  type FetchLike,
  type FindTimeInput,
  type FreeBusyInput,
  type InviteInput,
  type TimeSlot,
} from './backend.ts'

/**
 * One connected account, as the fan-out consumes it. Mirrors the gateway's
 * `ResolvedAccount` structurally so the composer passes its resolver straight
 * through without an adapter, while this Core stays free of a gateway import.
 */
export interface CalendarAccountDescriptor {
  /** Stable id for this account. Stamped onto every row read from it. */
  account_id: string
  /** Address of this account, when known. */
  account_email: string | null
  /** Lazy per-account token accessor. Null ⇒ this account is not connected. */
  accessToken: () => Promise<string | null>
}

/**
 * Resolves the CURRENT account set. Called per request, not once at build
 * time, so an account connected (or disconnected) after boot takes effect
 * without a restart — the same live-read contract the single-account
 * `accessToken` accessor has always had.
 */
export type CalendarAccountsResolver = () => Promise<readonly CalendarAccountDescriptor[]>

export interface MultiAccountCalendarClientOptions {
  accounts: CalendarAccountsResolver
  /** Override for tests / local dev. Forwarded to each per-account client. */
  baseUrl?: string
  /** Override fetch — forwarded to each per-account client. */
  fetchImpl?: FetchLike
  /**
   * Build the client for one account. Defaults to the Google REST client;
   * overridden in tests to substitute per-account fakes.
   */
  buildClient?: (account: CalendarAccountDescriptor) => CalendarClient
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

/**
 * Sort key for a row's start. `Date.parse` normalises timezone offsets, so two
 * accounts on different calendar timezones interleave correctly. All-day rows
 * (`YYYY-MM-DD`) parse as UTC midnight, which orders them at the head of their
 * day — the conventional place for an all-day entry in an agenda.
 */
function startInstant(row: CalendarEventRow): number {
  const ms = Date.parse(row.start)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

export function buildMultiAccountGoogleCalendarClient(
  options: MultiAccountCalendarClientOptions,
): CalendarClient {
  const buildClient =
    options.buildClient ??
    ((account: CalendarAccountDescriptor): CalendarClient =>
      buildGoogleCalendarClient({
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
  async function accountsOrThrow(): Promise<readonly CalendarAccountDescriptor[]> {
    const accounts = await options.accounts()
    if (accounts.length === 0) throw new OAuthMissingError()
    return accounts
  }

  /** The primary account's client — the target for writes and availability. */
  async function primary(): Promise<CalendarClient> {
    const accounts = await accountsOrThrow()
    // Non-null: accountsOrThrow guarantees a non-empty list.
    return buildClient(accounts[0] as CalendarAccountDescriptor)
  }

  /**
   * Walk accounts in fan-out order until one recognises the event id. Only
   * `EventNotFoundError` advances to the next account — any other error is the
   * caller's answer, because retrying a 500 against a different account would
   * turn one account's outage into a misleading "not found".
   */
  async function byEventId<T>(
    event_id: string,
    run: (client: CalendarClient) => Promise<T>,
  ): Promise<{ value: T; account: CalendarAccountDescriptor }> {
    const accounts = await accountsOrThrow()
    let notFound: EventNotFoundError | null = null
    for (const account of accounts) {
      try {
        return { value: await run(buildClient(account)), account }
      } catch (err) {
        if (err instanceof EventNotFoundError) {
          notFound = err
          continue
        }
        throw err
      }
    }
    throw notFound ?? new EventNotFoundError(event_id)
  }

  /** Stamp the account a row was read from / written to onto the row. */
  function tag(
    row: CalendarEventRow,
    account: CalendarAccountDescriptor,
  ): CalendarEventRow {
    return {
      ...row,
      account_id: account.account_id,
      ...(account.account_email !== null
        ? { account_email: account.account_email }
        : {}),
    }
  }

  async function listAcrossAccounts(
    input: CalendarListInput,
  ): Promise<CalendarListAcrossAccounts> {
    const accounts = await accountsOrThrow()
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    // Ask each account for the FULL limit: the merged set must still be able to
    // fill entirely from one account when the others are quiet.
    const settled = await Promise.allSettled(
      accounts.map((account) => buildClient(account).list({ ...input, limit })),
    )

    const outcomes: AccountReadOutcome[] = []
    const merged: CalendarEventRow[] = []
    const seen = new Set<string>()
    let firstFailure: unknown = null
    let okCount = 0

    for (let i = 0; i < accounts.length; i++) {
      // Non-null: index-aligned with `accounts` by construction.
      const account = accounts[i] as CalendarAccountDescriptor
      const result = settled[i] as PromiseSettledResult<CalendarEventRow[]>
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
          operation: 'list',
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
      for (const row of result.value) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        merged.push(tag(row, account))
      }
    }

    // Every account failed. Returning `[]` here would be an empty SUCCESS —
    // a clear schedule and a total outage would look identical. Surface the
    // first real error instead.
    if (okCount === 0 && firstFailure !== null) throw firstFailure

    merged.sort((a, b) => {
      const delta = startInstant(a) - startInstant(b)
      if (delta !== 0) return delta
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return { events: merged.slice(0, limit), accounts: outcomes }
  }

  return {
    listAcrossAccounts,
    async list(input: CalendarListInput): Promise<CalendarEventRow[]> {
      return (await listAcrossAccounts(input)).events
    },
    async create(input: CalendarCreateInput): Promise<CalendarEventRow> {
      const accounts = await accountsOrThrow()
      // Non-null: accountsOrThrow guarantees a non-empty list.
      const account = accounts[0] as CalendarAccountDescriptor
      return tag(await buildClient(account).create(input), account)
    },
    async update(input: CalendarUpdateInput): Promise<CalendarEventRow> {
      const { value, account } = await byEventId(input.event_id, (client) =>
        client.update(input),
      )
      return tag(value, account)
    },
    async cancel(input: CalendarCancelInput): Promise<void> {
      await byEventId(input.event_id, (client) => client.cancel(input))
    },
    async get(input: CalendarGetInput): Promise<CalendarEventRow> {
      const { value, account } = await byEventId(input.event_id, (client) =>
        client.get(input),
      )
      return tag(value, account)
    },
    async invite(input: InviteInput): Promise<CalendarEventRow> {
      const { value, account } = await byEventId(input.event_id, (client) =>
        client.invite(input),
      )
      return tag(value, account)
    },
    async freebusy(input: FreeBusyInput): Promise<BusyInterval[][]> {
      return await (await primary()).freebusy(input)
    },
    async findTime(input: FindTimeInput): Promise<TimeSlot[]> {
      return await (await primary()).findTime(input)
    },
  }
}
