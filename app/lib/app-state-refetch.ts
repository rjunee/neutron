/**
 * @neutronai/app — foreground-refetch trigger.
 *
 * OAuth "Connect" hands off to the SYSTEM browser via `Linking.openURL`
 * (Google blocks OAuth in webviews), which backgrounds the Expo app without
 * unmounting/blurring the current screen. So neither the mount-time fetch nor
 * `useFocusEffect` re-runs when the user returns — the screen would keep
 * showing the stale pre-connect status ("Not connected") even though the grant
 * succeeded server-side. The fix is to refetch when the app returns to the
 * foreground; this is the pure predicate that decides when to do so.
 *
 * Returns true only on a real background/inactive -> active transition, so a
 * spurious 'active' -> 'active' event (or going TO the background) never
 * triggers a refetch.
 */
import type { AppStateStatus } from 'react-native'

export function appStateBecameActive(prev: AppStateStatus, next: AppStateStatus): boolean {
  return next === 'active' && prev !== 'active'
}
