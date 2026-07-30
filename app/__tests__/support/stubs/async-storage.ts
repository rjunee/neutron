const mem = new Map<string, string>();
const AsyncStorage = {
  async getItem(k: string): Promise<string | null> { return mem.get(k) ?? null; },
  async setItem(k: string, v: string): Promise<void> { mem.set(k, v); },
  async removeItem(k: string): Promise<void> { mem.delete(k); },
  async multiRemove(ks: readonly string[]): Promise<void> { for (const k of ks) mem.delete(k); },
  async clear(): Promise<void> { mem.clear(); },
};
export default AsyncStorage;
