/**
 * @neutronai/channels — Telegram Bot API client.
 *
 * Minimal Bot API client scoped to the methods Sprint 7 needs:
 * sendMessage, answerCallbackQuery, setWebhook, getMe, getUpdates,
 * plus the Bot API 9.6 managed-bots primitives in `managed-bots.ts`.
 *
 * The client is fetch-based + injectable for tests. grammY remains the
 * documented SDK pick but P1 S4 does NOT take a grammY dependency —
 * we want the surface tight + testable. Sprint 8 (subdomain
 * provisioning) layers grammY on if a richer surface is needed.
 *
 * Retry-after parsing: 429 responses include `parameters.retry_after`
 * (seconds). The client surfaces these as a `TelegramRetryAfterError` so
 * the substrate dispatcher can apply the same backoff path as the
 * credential-pool 429 handling.
 */

export interface TelegramApiCallOptions {
  base_url?: string
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetcher?: typeof fetch
}

export interface TelegramSendMessageInput {
  chat_id: number | string
  /**
   * Bot API 9.6 — `message_thread_id` enables replies into a forum topic.
   * The Telegram channel adapter sets this to the topic's `channel_topic_id`
   * for instances whose chat is a supergroup with topics.
   */
  message_thread_id?: number
  text: string
  parse_mode?: 'HTML' | 'MarkdownV2'
  reply_markup?: unknown
  disable_web_page_preview?: boolean
}

export interface TelegramSendMessageResult {
  message_id: number
  chat: { id: number }
  date: number
}

export interface TelegramSetWebhookInput {
  url: string
  /** Bot API 9.6 — required for the per-instance bot pattern. */
  secret_token?: string
  allowed_updates?: string[]
  drop_pending_updates?: boolean
}

/** A file to upload in a multipart Bot API call. */
export interface TelegramUpload {
  bytes: Uint8Array
  filename: string
  content_type: string
}

export interface TelegramAnswerCallbackQueryInput {
  callback_query_id: string
  text?: string
  show_alert?: boolean
}

/**
 * Thrown when Telegram returns 429 with a retry_after hint. The substrate-
 * level dispatcher catches and applies cooldown like a credential-pool 429.
 */
export class TelegramRetryAfterError extends Error {
  constructor(
    readonly retry_after_ms: number,
    readonly endpoint: string,
  ) {
    super(`Telegram rate limited on ${endpoint}; retry after ${retry_after_ms}ms`)
    this.name = 'TelegramRetryAfterError'
  }
}

/**
 * Sprint 26 r2 (Argus IMPORTANT fix) — typed wrapper for non-OK Bot
 * API responses so callers can distinguish *poison* errors (token
 * revoked / malformed / banned bot — 401, 403, 404) from *transient*
 * errors (5xx, network blips). The bot-pool provisioning path needs
 * this distinction to avoid recycling a poisoned entry back into the
 * pool, which would silently infect every subsequent owner signup.
 *
 * The HTTP status (`status`) and Telegram error_code (`error_code`)
 * are both surfaced — the HTTP status is the primary classification
 * signal; the Bot API error_code echoes Telegram's own categorisation
 * for operator audit trails.
 */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError'
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly error_code: number | undefined,
    readonly description: string | undefined,
  ) {
    super(
      `Telegram ${endpoint} failed: status=${status} code=${error_code ?? 'n/a'} ${description ?? '(no description)'}`,
    )
  }
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export class TelegramClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(
    private readonly token: string,
    options: TelegramApiCallOptions = {},
  ) {
    if (!token) throw new Error('TelegramClient requires a non-empty token')
    this.baseUrl = options.base_url ?? 'https://api.telegram.org'
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  async call<TIn, TOut>(method: string, body: TIn): Promise<TOut> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`
    const res = await this.fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let payload: TelegramApiResponse<TOut>
    try {
      payload = (await res.json()) as TelegramApiResponse<TOut>
    } catch (err) {
      throw new Error(`Telegram ${method}: non-JSON response (status=${res.status}): ${(err as Error).message}`)
    }
    if (payload.ok && payload.result !== undefined) return payload.result
    if (res.status === 429 && payload.parameters?.retry_after !== undefined) {
      throw new TelegramRetryAfterError(payload.parameters.retry_after * 1000, method)
    }
    throw new TelegramApiError(method, res.status, payload.error_code, payload.description)
  }

  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageResult> {
    return this.call<TelegramSendMessageInput, TelegramSendMessageResult>('sendMessage', input)
  }

  setWebhook(input: TelegramSetWebhookInput): Promise<true> {
    return this.call<TelegramSetWebhookInput, true>('setWebhook', input)
  }

  answerCallbackQuery(input: TelegramAnswerCallbackQueryInput): Promise<true> {
    return this.call<TelegramAnswerCallbackQueryInput, true>('answerCallbackQuery', input)
  }

  /**
   * Multipart variant of {@link call}, for the methods that upload a file. Every
   * non-file field is sent as a string part; a `TelegramUpload` value becomes a
   * file part. Error handling is identical to `call`.
   */
  async callMultipart<TOut>(
    method: string,
    fields: Record<string, string | number | TelegramUpload | undefined>,
  ): Promise<TOut> {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      if (typeof v === 'object') {
        form.append(k, new Blob([v.bytes as Uint8Array<ArrayBuffer>], { type: v.content_type }), v.filename)
      } else {
        form.append(k, String(v))
      }
    }
    const url = `${this.baseUrl}/bot${this.token}/${method}`
    const res = await this.fetcher(url, { method: 'POST', body: form })
    let payload: TelegramApiResponse<TOut>
    try {
      payload = (await res.json()) as TelegramApiResponse<TOut>
    } catch (err) {
      throw new Error(`Telegram ${method}: non-JSON response (status=${res.status}): ${(err as Error).message}`)
    }
    if (payload.ok && payload.result !== undefined) return payload.result
    if (res.status === 429 && payload.parameters?.retry_after !== undefined) {
      throw new TelegramRetryAfterError(payload.parameters.retry_after * 1000, method)
    }
    throw new TelegramApiError(method, res.status, payload.error_code, payload.description)
  }

  /** Resolve a `file_id` to a downloadable `file_path` (Bot API files are capped at 20 MB). */
  getFile(file_id: string): Promise<{ file_id: string; file_size?: number; file_path?: string }> {
    return this.call<{ file_id: string }, { file_id: string; file_size?: number; file_path?: string }>(
      'getFile',
      { file_id },
    )
  }

  /**
   * Download a file previously resolved by {@link getFile}. Refuses anything
   * larger than `max_bytes`, both by the declared length and by what actually
   * arrives, so a lying `Content-Length` cannot overrun the cap.
   */
  async downloadFile(file_path: string, max_bytes: number): Promise<Uint8Array> {
    if (file_path.includes('..')) throw new Error('Telegram downloadFile: refusing a path with ".."')
    const res = await this.fetcher(`${this.baseUrl}/file/bot${this.token}/${file_path}`, { method: 'GET' })
    if (!res.ok) throw new TelegramApiError('downloadFile', res.status, undefined, undefined)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > max_bytes) {
      throw new Error(`Telegram downloadFile: ${declared} bytes exceeds the ${max_bytes}-byte cap`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > max_bytes) {
      throw new Error(`Telegram downloadFile: ${buf.byteLength} bytes exceeds the ${max_bytes}-byte cap`)
    }
    return buf
  }

  /** `sendPhoto` / `sendVideo` / `sendDocument` with an uploaded file. */
  sendFile(input: {
    method: 'sendPhoto' | 'sendVideo' | 'sendDocument'
    chat_id: number | string
    file: TelegramUpload
    caption?: string
    message_thread_id?: number
  }): Promise<TelegramSendMessageResult> {
    const field = input.method === 'sendPhoto' ? 'photo' : input.method === 'sendVideo' ? 'video' : 'document'
    return this.callMultipart<TelegramSendMessageResult>(input.method, {
      chat_id: String(input.chat_id),
      [field]: input.file,
      caption: input.caption,
      message_thread_id: input.message_thread_id,
    })
  }

  /**
   * `sendMediaGroup` — 2 to 10 photos and videos posted as one album. Each item
   * is attached as its own multipart part and referenced by `attach://<name>`.
   */
  sendMediaGroup(input: {
    chat_id: number | string
    items: ReadonlyArray<{ type: 'photo' | 'video'; file: TelegramUpload; caption?: string }>
    message_thread_id?: number
  }): Promise<TelegramSendMessageResult[]> {
    if (input.items.length < 2 || input.items.length > 10) {
      throw new Error(`Telegram sendMediaGroup takes 2 to 10 items, got ${input.items.length}`)
    }
    const fields: Record<string, string | number | TelegramUpload | undefined> = {
      chat_id: String(input.chat_id),
      message_thread_id: input.message_thread_id,
    }
    const media = input.items.map((item, i) => {
      fields[`file${i}`] = item.file
      return {
        type: item.type,
        media: `attach://file${i}`,
        ...(item.caption !== undefined ? { caption: item.caption } : {}),
      }
    })
    fields['media'] = JSON.stringify(media)
    return this.callMultipart<TelegramSendMessageResult[]>('sendMediaGroup', fields)
  }

  /** Show "typing…" (or another chat action) for about five seconds. */
  sendChatAction(input: { chat_id: number | string; action: 'typing' | 'upload_photo' | 'upload_video' | 'upload_document' }): Promise<true> {
    return this.call<typeof input, true>('sendChatAction', input)
  }

  getMe(): Promise<{ id: number; username: string; is_bot: boolean }> {
    return this.call<Record<string, never>, { id: number; username: string; is_bot: boolean }>(
      'getMe',
      {},
    )
  }
}
