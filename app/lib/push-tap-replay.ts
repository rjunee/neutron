import type { PushTapDedupeStore } from './push-tap-dedupe-store';

export type PushTapSource = 'cold-start' | 'warm-listener';

/**
 * Only a cached cold-start response is a replay. A warm-listener response is a
 * fresh interaction, even when its notification identifier has been seen.
 */
export function shouldSkipPushTap(
  store: Pick<PushTapDedupeStore, 'has'>,
  id: string,
  source: PushTapSource,
): boolean {
  return source === 'cold-start' && store.has(id);
}
