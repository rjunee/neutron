/**
 * @neutronai/gateway/realmode-composer — Telegram webhook surface factory.
 *
 * Resolve Telegram bot secrets from the per-instance SecretsStore + build a
 * webhook handler. Returns null when any required secret is missing — the
 * caller should skip wiring `/webhook/telegram` (the route 404s through
 * the default fallback chain, no crash).
 *
 * Secret labels (locked Sprint 19):
 *   kind='bot_token',         label='telegram'  → API token. Presence
 *                                                  gates the surface; the
 *                                                  token itself isn't used
 *                                                  by the webhook handler
 *                                                  (only by the outbound
 *                                                  sender, which lives
 *                                                  elsewhere).
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
import { buildWebhookHandler } from '@neutronai/channels/adapters/telegram/webhook-server.ts'
import type { IncomingEventReceiver } from '@neutronai/channels/types.ts'
import type {
  TelegramStartCommandHandler,
  TelegramBindCommandHandler,
} from '@neutronai/channels/adapters/telegram/webhook-server.ts'

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
}

export async function buildTelegramWebhookSurface(
  input: BuildTelegramWebhookSurfaceInput,
): Promise<TelegramWebhookSurface | null> {
  const log_slug =
    input.url_slug !== undefined && input.url_slug.length > 0
      ? input.url_slug
      : input.internal_handle
  const [botToken, webhookSecret, botUserIdRaw] = await Promise.all([
    input.secrets.get({
      internal_handle: input.internal_handle,
      kind: 'bot_token',
      label: 'telegram',
    }),
    input.secrets.get({
      internal_handle: input.internal_handle,
      kind: 'webhook_secret',
      label: 'telegram',
    }),
    input.secrets.get({
      internal_handle: input.internal_handle,
      kind: 'channel_metadata',
      label: 'telegram-bot-user-id',
    }),
  ])
  if (botToken === null) {
    console.info(
      `[composer] project=${log_slug} bot_token (label=telegram) not seeded — skipping /webhook/telegram`,
    )
    return null
  }
  if (webhookSecret === null) {
    console.info(
      `[composer] project=${log_slug} webhook_secret (label=telegram) not seeded — skipping /webhook/telegram`,
    )
    return null
  }
  if (botUserIdRaw === null) {
    console.info(
      `[composer] project=${log_slug} bot_user_id (kind=channel_metadata, label=telegram-bot-user-id) not seeded — skipping /webhook/telegram`,
    )
    return null
  }
  const botUserId = Number.parseInt(botUserIdRaw, 10)
  if (!Number.isFinite(botUserId) || botUserId <= 0) {
    console.warn(
      `[composer] project=${log_slug} bot_user_id is not a positive integer (got ${JSON.stringify(botUserIdRaw)}) — skipping /webhook/telegram`,
    )
    return null
  }
  return {
    handler: buildWebhookHandler({
      bot_user_id: botUserId,
      secret_token: webhookSecret,
      receiver: input.receiver,
      ...(input.on_start_command !== undefined ? { on_start_command: input.on_start_command } : {}),
      ...(input.on_bind_command !== undefined ? { on_bind_command: input.on_bind_command } : {}),
    }),
  }
}
