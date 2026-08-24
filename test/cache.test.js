const { createCache } = require('../config/CatchMap');

const entry = (body) => ({ body, vary: [] });

describe('cache adapter', () => {
  test('sets, gets, checks, and deletes entries', () => {
    const cache = createCache();
    cache.set('GET:/users/1', entry('Ada'));

    expect(cache.has('GET:/users/1')).toBe(true);
    expect(cache.get('GET:/users/1')).toMatchObject({ body: 'Ada' });
    expect(cache.delete('GET:/users/1')).toBe(true);
    expect(cache.has('GET:/users/1')).toBe(false);
  });

  test('expires entries after its configured TTL', async () => {
    const cache = createCache({ ttl: 20 });
    cache.set('GET:/short-lived', entry('temporary'));

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(cache.get('GET:/short-lived')).toBeUndefined();
  });

  test('evicts the least recently used entry at max size', () => {
    const cache = createCache({ max: 2 });
    cache.set('GET:/a', entry('a'));
    cache.set('GET:/b', entry('b'));
    cache.get('GET:/a'); // Keep /a recent so /b is the eviction candidate.
    cache.set('GET:/c', entry('c'));

    expect(cache.get('GET:/a')).toBeDefined();
    expect(cache.get('GET:/b')).toBeUndefined();
    expect(cache.get('GET:/c')).toBeDefined();
  });
});
