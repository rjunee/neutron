/**
 * @neutronai/channels — public barrel.
 *
 * Exports the channel-agnostic abstractions (`types.ts`, `router.ts`) and
 * the Telegram adapter family. (Per-instance-bot provisioning primitives are
 * Managed-side machinery and live in the provisioning module.)
 */

export const __MODULE__ = '@neutronai/channels' as const

export type {
  ChannelKind,
  Topic,
  ChannelUser,
  IncomingEvent,
  OutgoingMessage,
  InlineChoice,
  ChannelAdapterManifest,
  ChannelAdapter,
  IncomingEventReceiver,
} from './types.ts'

export { ChannelRouter, type TopicHandler } from './router.ts'

// Button primitive (P2 S1)
export {
  buildButtonPrompt,
  canonicalPromptSeed,
  decodePromptIdWire,
  deriveIdempotencyKey,
  encodePromptIdWire,
  validateButtonPrompt,
  ButtonPrimitiveError,
  CALLBACK_DATA_BYTE_CAP,
  DEFAULT_EXPIRES_IN_MS,
  MAX_OPTIONS_TELEGRAM,
  PROMPT_ID_WIRE_LEN,
  RESERVED_OPTION_VALUES,
  ROUTING_PREFIX,
  VALUE_BYTE_CAP,
  type ButtonChoice,
  type ButtonOption,
  type ButtonPrompt,
  type ButtonPrimitiveErrorCode,
  type ChannelKindForButton,
} from './button-primitive.ts'

export {
  ButtonStore,
  ButtonStoreError,
  type ButtonStoreErrorCode,
  type ButtonStoreOptions,
  type EmitInput as ButtonStoreEmitInput,
  type EmitResult as ButtonStoreEmitResult,
  type ResolveInput as ButtonStoreResolveInput,
  type ResolveResult as ButtonStoreResolveResult,
} from './button-store.ts'

export {
  DefaultButtonRouter,
  parseTelegramCallbackData,
  type ButtonRouter,
  type DefaultButtonRouterDeps,
  type RouteChoiceInput,
  type RouteChoiceResult,
} from './button-routing.ts'

export {
  encodeCallbackData,
  decorationFor,
  renderButtonPromptTelegram,
  type RenderedButtonPrompt,
} from './adapters/telegram/render-button-prompt.ts'

export {
  buildTelegramCallbackHandler,
  type TelegramCallbackHandlerResult,
  type TelegramCallbackQueryPayload,
  type TelegramCallbackRouterDeps,
} from './adapters/telegram/callback-router.ts'

export {
  AppSocketRenderNotWiredError,
  renderButtonPromptAppSocket,
  type AppSocketButtonChoiceMessage,
  type AppSocketButtonPromptMessage,
} from './adapters/app-socket/render-button-prompt.ts'

// P5.1 — app-ws (Expo) adapter family.
export { AppWsAdapter, type AppWsAdapterOptions } from './adapters/app-ws/adapter.ts'
export {
  createAppWsAuthResolver,
  type AppWsAuthResolver,
  type AppWsAuthResolved,
  type AppWsAuthError,
  type AppWsAuthMode,
  type AppWsAuthResolverOptions,
} from './adapters/app-ws/auth.ts'
export {
  InMemoryAppWsSessionRegistry,
  type AppWsSessionRegistry,
  type AppWsClientPlatform,
  type AppWsRegisterOptions,
} from './adapters/app-ws/session-registry.ts'
export {
  appWsTopicId,
  parseAppWsTopicId,
  decodeAppWsInbound,
  sanitizePlatform as sanitizeAppWsPlatform,
  sanitizeProjectId as sanitizeAppWsProjectId,
  MAX_USER_MESSAGE_LEN as APP_WS_MAX_USER_MESSAGE_LEN,
  MAX_PROJECT_ID_LEN as APP_WS_MAX_PROJECT_ID_LEN,
  type AppWsInbound,
  type AppWsInboundUserMessage,
  type AppWsOutbound,
  type AppWsOutboundSessionReady,
  type AppWsOutboundUserMessageEcho,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentMessageOption,
  type AppWsOutboundError,
} from './adapters/app-ws/envelope.ts'

// Telegram adapter
export {
  TelegramAdapter,
  type TelegramAdapterOptions,
} from './adapters/telegram/index.ts'
export {
  TelegramClient,
  TelegramRetryAfterError,
  type TelegramApiCallOptions,
  type TelegramSendMessageInput,
  type TelegramSendMessageResult,
  type TelegramSetWebhookInput,
  type TelegramAnswerCallbackQueryInput,
} from './adapters/telegram/client.ts'
export {
  truncateForTelegram,
  countUtf16,
  TELEGRAM_MESSAGE_MAX_UTF16,
} from './adapters/telegram/utf16-truncation.ts'
export {
  SelfEchoFilter,
  hashText,
  type OutgoingFingerprint,
  type IncomingFingerprintProbe,
  type SyncFilterOptions,
} from './adapters/telegram/sync-message-filter.ts'
export {
  renderInlineKeyboard,
  type TelegramInlineKeyboardButton,
  type TelegramReplyMarkup,
  type RenderOptions as TelegramInlineKeyboardRenderOptions,
} from './adapters/telegram/inline-keyboards.ts'
export {
  buildWebhookHandler,
  decodeUpdate,
  dispatchStartCommandIfOnboarding,
  type TelegramUpdate,
  type WebhookHandlerOptions,
  type TelegramCallbackQueryHandler,
  type TelegramStartCommandHandler,
} from './adapters/telegram/webhook-server.ts'
export { runLongPoll, type LongPollOptions } from './adapters/telegram/long-poll.ts'
export {
  createForumTopic,
  editForumTopic,
  closeForumTopic,
  reopenForumTopic,
  deleteForumTopic,
  type CreateForumTopicInput,
  type ForumTopicResult,
} from './adapters/telegram/forum-topics.ts'
