const { LRUCache } = require('lru-cache');

const headerValue = (headers, name) => headers[name.toLowerCase()] || '';
const variantKey = (key, vary, headers) =>
  `${key}|${vary.map((name) => `${name}=${headerValue(headers, name)}`).join('&')}`;

// The factory keeps the controller independent from the in-memory LRU implementation.
const createCache = ({ max = 100, ttl = 0 } = {}) => {
  const store = new LRUCache({ max, ttl });
  const variants = new Map();

  return {
    get(key, headers = {}) {
      const keys = variants.get(key);
      if (!keys) return undefined;
      for (const candidate of keys) {
        const entry = store.get(candidate);
        if (entry && candidate === variantKey(key, entry.vary || [], headers)) return entry;
      }
    },
    has(key, headers = {}) {
      return Boolean(this.get(key, headers));
    },
    set(key, entry, headers = {}) {
      const cacheKey = variantKey(key, entry.vary || [], headers);
      store.set(cacheKey, entry);
      if (!variants.has(key)) variants.set(key, new Set());
      variants.get(key).add(cacheKey);
    },
    delete(key) {
      const keys = variants.get(key);
      if (keys) {
        for (const cacheKey of keys) store.delete(cacheKey);
        variants.delete(key);
        return true;
      }
      return store.delete(key);
    },
    clear() {
      store.clear();
      variants.clear();
    },
    get size() {
      return store.size;
    }
  };
};

const cache = createCache();
module.exports = cache;
module.exports.createCache = createCache;
