import { WarmSessionCache } from '@neutronai/chat-core';
import type { MobileChatSession } from './mobile-session';

export { MAX_WARM_SESSIONS, SESSION_BUILD_TIMEOUT_MS } from '@neutronai/chat-core';

const cache = new WarmSessionCache<MobileChatSession>();

export async function acquireSession(
  key: string,
  factory: () => Promise<MobileChatSession>,
): Promise<MobileChatSession> {
  return cache.acquireAsync(key, factory);
}

export function releaseSession(key: string): void {
  cache.release(key);
}

export function setCacheActive(active: boolean): void {
  cache.setActive(active);
}

export function clearSessionCache(): void {
  cache.clear();
}

export function sessionCacheKeys(): readonly string[] {
  return cache.keys();
}

export function sessionRefCount(key: string): number {
  return cache.refCount(key);
}

export function peekSession(key: string): MobileChatSession | null {
  return cache.peek(key);
}
