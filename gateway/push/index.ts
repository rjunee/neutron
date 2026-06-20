/**
 * @neutronai/gateway/push — public barrel.
 *
 * P5.6 — native push notifications via the Expo Push API. The module
 * has three independently-testable pieces:
 *
 *   * `DevicePushTokenStore` — per-project device-token DDL wrapper
 *     (migration 0033).
 *   * `createExpoPushClient` — thin HTTP wrapper around the Expo Push
 *     API endpoint. Inject a `fetch` impl in tests.
 *   * `createPushDispatcher` — glue layer that the reminder tick loop's
 *     `onFired` hook calls. Failure-safe: thrown HTTP / network errors
 *     are logged and downgraded so they cannot stop a reminder from
 *     marking fired.
 *
 * Per SPEC.md § Phases→Steps (P5.6) +
 * docs/engineering-plan.md § B.P5.
 */

export const __MODULE__ = '@neutronai/gateway/push' as const

export {
  DevicePushTokenStore,
  ALL_DEVICE_PUSH_PLATFORMS,
  isDevicePushPlatform,
} from './store.ts'
export type {
  DevicePushPlatform,
  DevicePushToken,
  RegisterDeviceTokenInput,
} from './store.ts'

export {
  createExpoPushClient,
  ExpoPushError,
  DEFAULT_EXPO_PUSH_ENDPOINT,
  EXPO_PUSH_BATCH_SIZE,
} from './expo-push-client.ts'
export type {
  ExpoFetch,
  ExpoPushClient,
  ExpoPushClientOptions,
  ExpoPushMessage,
  ExpoPushTicket,
  ExpoPushSendResult,
} from './expo-push-client.ts'

export { createPushDispatcher } from './dispatcher.ts'
export type {
  PushDispatcher,
  PushDispatcherOptions,
  PushDispatcherLogger,
  PushResult,
} from './dispatcher.ts'
