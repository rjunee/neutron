/**
 * @neutronai/gateway/wiring — Telegram webhook surface factory.
 *
 * Resolve Telegram bot secrets from the per-instance SecretsStore + build a
 * webhook handler. Returns null when any required secret is missing — the
 * caller should skip wiring `/webhook/telegram` (the route 404s through
 * the default fallback chain, no crash).
 *
 * Secret labels (locked Sprint 19):
 *   kind='bot_token',         label='telegram'  → API token. Presence
 *                                                  gates the surface. X5: the
 *                                                  token now builds the
 *                                                  `TelegramClient` behind the
 *                                                  instantiated `TelegramAdapter`
 *                                                  (its outbound `send`); the
 *                                                  inbound webhook handler still
 *                                                  does not read it.
 *   kind='webhook_secret',    label='telegram'  → secret_token used in the
 *                                                  X-Telegram-Bot-Api-
 *                                                  Secret-Token header.
 *   kind='channel_metadata',  label='telegram-bot-user-id'
 *                                                → bot's own numeric user id
 *                                                  (returned by Telegram's
 *                                                  getMe). PUBLIC integer,
 *                                                  not a secret — but
 *                                                  stored alongside secrets
 *                                                  for operator-config-
 *                                                  locality.
 *
 * IMPORTANT: this factory does NOT swallow `SecretsStoreError`. The
 * composer (Phase 5) wraps the call in try/catch — corruption logging
 * happens at the call site so the chat surface stays wired even if
 * Telegram secrets are corrupt.
 */

import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { TelegramAdapter } from '@neutronai/channels/adapters/telegram/index.ts'
import { TelegramClient } from '@neutronai/channels/adapters/telegram/client.ts'
import type { IncomingEventReceiver } from '@neutronai/channels/types.ts'
import type {
  TelegramStartCommandHandler,
  TelegramBindCommandHandler,
} from '@neutronai/channels/adapters/telegram/webhook-server.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('telegram-webhook-composer')

export interface BuildTelegramWebhookSurfaceInput {
  /**
   * 2026-05-12 — frozen `internal_handle` for the SecretsStore lookup
   * (see `auth/secrets-store.ts` file header). Was previously
   * `project_slug`; the rename is mandatory because renamed instances
   * keep their bot secrets at the original handle.
   */
  internal_handle: string
  /**
   * Mutable `url_slug` — used ONLY for log readability so journald
   * greps match the user-facing identifier. Optional; defaults to
   * `internal_handle` when unset.
   */
  url_slug?: string
  secrets: SecretsStore
  /** Pre-built ChannelRouter from the composer (passed via composition.channel_router). */
  receiver: IncomingEventReceiver
  /**
   * Sprint 26 — optional bot-command handler for `/start onboard_<correlator>`
   * deeplinks. Production wires this to
   * `signup/telegram-start-handler.ts:buildTelegramStartHandler` against the
   * per-instance `signin_events` correlator store + JWKS. Absent → /start
   * deeplinks fall through to the generic message decoder.
   */
  on_start_command?: TelegramStartCommandHandler
  /**
   * ISSUES #65 (2026-05-29) — optional bot-command handler for
   * `/start bind_<token>` deeplinks emitted by the final-handoff [B]
   * Connect a Telegram bot prompt. Production wires this to
   * `signup/telegram-bind-handler.ts:buildTelegramBindHandler` against
   * the per-instance `telegram_bind_tokens` + `telegram_bindings` tables
   * (migration 0051). Absent → bind deeplinks fall through to
   * `on_start_command` (which won't match `bind_`) and then to
   * `decodeUpdate`, silently dropping the bind. Symmetric with
   * `on_start_command` shape.
   */
  on_bind_command?: TelegramBindCommandHandler
}

export interface TelegramWebhookSurface {
  handler: (req: Request) => Promise<Response>
  /**
   * X5 — the instantiated `TelegramAdapter` behind the handler. The inbound
   * `handler` is `adapter.webhookHandler()`, so the class IS the real Telegram
   * INBOUND path now (it was never instantiated before — `buildWebhookHandler`
   * was mounted directly). The adapter also carries the OUTBOUND `send`.
   *
   * SCOPE NOTE: this Open repo never wires Telegram (no Telegram secrets /
   * instance — `buildTelegramWebhookSurface` is called only by the Managed
   * composer), so there is intentionally NO `registerAdapter(surface.adapter)`
   * call here. Exposing the adapter is what MAKES the one-line outbound
   * activation possible in the Telegram-instance (Managed) composer
   * (`router.registerAdapter(surface.adapter)`) — the documented "add a channel
   * = one registration" recipe. Kept ADDITIVE and unregistered here to avoid a
   * double-registration conflict with any existing Managed outbound sender.
   * Existing callers that read only `.handler` are unaffected.
   */
  adapter: TelegramAdapter
}

export async function buildTelegramWebhookSurface(
  input: BuildTelegramWebhookSurfaceInput,
): Promise<TelegramWebhookSurface | null> {
  const log_slug =
    input.url_slug !== undefined && input.url_slug.length > 0
      ? input.url_slug
      : input.internal_handle
  // `internal_handle` is the FROZEN registry PK (distinct from `url_slug`
  // above); brand it once for the secret lookups.
  const owner_handle = asOwnerHandle(input.internal_handle)
  const [botToken, webhookSecret, botUserIdRaw] = await Promise.all([
    input.secrets.get({
      internal_handle: owner_handle,
      kind: 'bot_token',
      label: 'telegram',
    }),
    input.secrets.get({
      internal_handle: owner_handle,
      kind: 'webhook_secret',
      label: 'telegram',
    }),
    input.secrets.get({
      internal_handle: owner_handle,
      kind: 'channel_metadata',
      label: 'telegram-bot-user-id',
    }),
  ])
  if (botToken === null) {
    moduleLog.info('skip_webhook_no_bot_token', { project: log_slug })
    return null
  }
  if (webhookSecret === null) {
    moduleLog.info('skip_webhook_no_webhook_secret', { project: log_slug })
    return null
  }
  if (botUserIdRaw === null) {
    moduleLog.info('skip_webhook_no_bot_user_id', { project: log_slug })
    return null
  }
  const botUserId = Number.parseInt(botUserIdRaw, 10)
  if (!Number.isFinite(botUserId) || botUserId <= 0) {
    moduleLog.warn(
      `[composer] project=${log_slug} bot_user_id is not a positive integer (got ${JSON.stringify(botUserIdRaw)}) — skipping /webhook/telegram`,
    )
    return null
  }
  // X5 — instantiate the real `TelegramAdapter` (previously the class was never
  // constructed; `buildWebhookHandler` was mounted directly). The inbound handler
  // is derived from the SAME adapter via `.webhookHandler()`, which forwards the
  // identical options to `buildWebhookHandler` — so inbound behaviour is
  // byte-identical. The client is side-effect-free at construction (no network
  // until a `send`); it is what makes the adapter's OUTBOUND `send` real, which a
  // Telegram instance activates by registering `surface.adapter` on its router.
  const client = new TelegramClient(botToken)
  const adapter = new TelegramAdapter({
    client,
    bot_user_id: botUserId,
    webhook_secret_token: webhookSecret,
    receiver: input.receiver,
    ...(input.on_start_command !== undefined ? { on_start_command: input.on_start_command } : {}),
    ...(input.on_bind_command !== undefined ? { on_bind_command: input.on_bind_command } : {}),
  })
  return {
    handler: adapter.webhookHandler(),
    adapter,
  }
}
