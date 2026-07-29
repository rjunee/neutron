/**
 * @neutronai/app — op-sqlite adapter + the mobile Store factory.
 *
 * Binds {@link SqliteChatStore} (driver-agnostic, fully unit-tested) to
 * op-sqlite, the JSI-fast on-device SQLite the research doc recommends for RN
 * (§5/§6). This file is the ONLY place the native module is referenced, so
 * the store class + every test stay free of a native dependency.
 *
 * GRACEFUL DEGRADATION (mirrors chat-core's `createWebStore`): op-sqlite is a
 * native module — it is absent under RN-for-Web, under Expo Go without the
 * dev client, and in any JS-only runtime. {@link createMobileStore} feature-
 * detects and silently falls back to chat-core's `InMemoryStore` so the chat
 * surface NEVER fails to construct a working Store; it simply loses durability
 * until the native build is present.
 */

import { InMemoryStore, type Store } from '@neutronai/chat-core';

import {
  SqliteChatStore,
  type SqlRow,
  type SqliteExecutor,
  type SqlValue,
} from './sqlite-store';

/** Default on-device database filename. */
export const MOBILE_DB_NAME = 'neutron-chat.db';

/** Shape of the op-sqlite result we consume (version-tolerant). */
interface OpSqliteResult {
  rows?: SqlRow[] | { _array?: SqlRow[] } | undefined;
}
interface OpSqliteDb {
  execute(sql: string, params?: SqlValue[]): OpSqliteResult | Promise<OpSqliteResult>;
  executeAsync?: (sql: string, params?: SqlValue[]) => Promise<OpSqliteResult>;
}

/** Normalize op-sqlite's result (`rows` is an array in v9+, `{_array}` in
 *  older builds) into the executor's `{ rows }` shape. */
function normalizeRows(result: OpSqliteResult): SqlRow[] {
  const rows = result.rows;
  if (Array.isArray(rows)) return rows;
  if (rows !== null && rows !== undefined && Array.isArray(rows._array)) return rows._array;
  return [];
}

/** Wrap an open op-sqlite database as a {@link SqliteExecutor}. */
export function opSqliteExecutor(db: OpSqliteDb): SqliteExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rows: SqlRow[] }> {
      const bind = params as SqlValue[];
      const result =
        typeof db.executeAsync === 'function'
          ? await db.executeAsync(sql, bind)
          : await db.execute(sql, bind);
      return { rows: normalizeRows(result) };
    },
  };
}

/**
 * Construct the best available mobile Store: an op-sqlite-backed durable store
 * when the native module is present, else an in-memory fallback. NEVER throws
 * — the chat surface can always get a working Store.
 *
 * @param dbName override the database filename (tests / multi-account).
 */
export async function createMobileStore(dbName: string = MOBILE_DB_NAME): Promise<Store> {
  try {
    // Dynamic import so a JS-only runtime (web, Expo Go, the unit suite) never
    // hard-fails on the missing native binding — the catch hands back the
    // in-memory fallback.
    const mod = (await import('@op-engineering/op-sqlite')) as unknown as {
      open?: (opts: { name: string }) => OpSqliteDb;
    };
    if (typeof mod.open !== 'function') return new InMemoryStore();
    const db = mod.open({ name: dbName });
    return await SqliteChatStore.open(opSqliteExecutor(db));
  } catch {
    return new InMemoryStore();
  }
}
