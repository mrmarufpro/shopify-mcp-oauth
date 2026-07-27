import type { CacheStore } from "../types";

interface Entry {
  value: string;
  expiresAt: number;
}

export function memoryCache(): CacheStore {
  const entries = new Map<string, Entry>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return read(key);
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    async getdel(key) {
      const value = read(key);
      entries.delete(key);
      return value;
    },
  };
}
