import { clear, createStore, del, entries, get, set, type UseStore } from 'idb-keyval';

/** Tiny async key-value interface so storage can be partitioned per user and faked in tests. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
  wipe(): Promise<void>;
}

/** One IndexedDB database PER authenticated user id. A different account on the same browser can never see this data. */
export const dbNameFor = (userId: string) => `lifeos-v5:${userId}`;

export function idbKV(userId: string): KV {
  if (!userId) throw new Error('idbKV requires a user id');
  const store: UseStore = createStore(dbNameFor(userId), 'kv');
  return {
    get: k => get(k, store),
    set: (k, v) => set(k, v, store),
    del: k => del(k, store),
    entries: async <T,>(prefix: string) =>
      (await entries<string, T>(store)).map(([k, v]) => [String(k), v] as [string, T])
        .filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    wipe: () => clear(store),
  };
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async k => m.get(k) as any,
    set: async (k, v) => { m.set(k, structuredClone(v)); },
    del: async k => { m.delete(k); },
    entries: async <T,>(prefix: string) =>
      [...m.entries()].filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => [k, structuredClone(v)] as [string, T]),
    wipe: async () => { m.clear(); },
  };
}

/** Remove storage written by slice 1, which was shared by every account on the browser. */
export function purgeLegacyShared() {
  try { indexedDB.deleteDatabase('keyval-store'); localStorage.removeItem('ws-list'); } catch { /* ignore */ }
}
