# ProxyCache

ProxyCache is a small HTTP caching proxy built with Node.js and Express. It forwards requests to an origin server, caches safe `GET` responses in an in-memory LRU cache, and preserves key origin caching rules such as `Cache-Control`, `ETag`, and `Vary`.

## Architecture

```text
Client
  |
  v
Express middleware (logging, rate limit, error handling)
  |
  v
Routes -> HandleRequest -> LRU cache
                         | HIT: return cached response
                         | MISS/BYPASS
                         v
                    Origin server
```

## Setup and run

```bash
npm install
cp .env.example .env
npm start
```

The proxy listens on `http://localhost:4000` by default. For containers, run:

```bash
docker compose up --build
```

## Environment variables

| Variable               | Default                | Purpose                                     |
| ---------------------- | ---------------------- | ------------------------------------------- |
| `ORIGIN_URL`           | `http://dummyjson.com` | Base URL of the upstream origin             |
| `PORT`                 | `4000`                 | Port used by the proxy                      |
| `LOG_LEVEL`            | `info`                 | Pino logging level                          |
| `RATE_LIMIT_WINDOW_MS` | `60000`                | Rate-limit window in milliseconds           |
| `RATE_LIMIT_MAX`       | `100`                  | Requests allowed per window per client      |
| `ORIGIN_TIMEOUT_MS`    | `10000`                | Maximum time to wait for an origin response |

## Examples

The first cacheable `GET` is a miss; repeat it to receive a hit.

```bash
curl -i http://localhost:4000/products/1
# X-Cache: MISS

curl -i http://localhost:4000/products/1
# X-Cache: HIT
```

Unsafe methods are always forwarded.

```bash
curl -i -X POST http://localhost:4000/products/add \
  -H 'Content-Type: application/json' \
  -d '{"title":"New product"}'
# X-Cache: BYPASS
```

Useful operational endpoints:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/cache/stats
curl -X DELETE http://localhost:4000/cache
curl -X DELETE 'http://localhost:4000/cache/%2Fproducts%2F1'
```

## Tests and quality checks

```bash
npm test
npm run lint
```

The test suite covers cache operations, expiry and eviction, plus proxy cache hits/misses, unsafe-method bypasses, and origin failures.

## Design decisions

**LRU caching.** Memory is bounded by a fixed maximum, and recently used responses are retained when capacity is reached. The cache adapter keeps the controller independent of this implementation, making a future Redis backend straightforward.

**Method-aware caching.** Only `GET` requests are cached. Methods that can change server state (`POST`, `PUT`, `PATCH`, and `DELETE`) are forwarded directly to avoid serving stale or unsafe results.

**Origin-led freshness.** The proxy honors `no-store`, `no-cache`, `max-age`, `ETag`, and `Vary` rather than applying a blanket response TTL.
