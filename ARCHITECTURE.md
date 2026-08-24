# ProxyCache Architecture Guide

This document describes the code that currently exists in this repository. It is deliberately explicit about features that are implemented, features that are only prepared for later work, and the trade-offs of the current single-process design.

## 1. Project Overview

ProxyCache is a Node.js/Express HTTP proxy. A client makes requests to ProxyCache instead of directly to an origin server. The proxy forwards the request to `ORIGIN_URL` and, for eligible `GET` responses, stores a copy in an in-memory least-recently-used (LRU) cache.

This is useful when many clients request the same safe, cacheable resource: the first request goes upstream, while later requests can be served locally. That reduces origin load and can improve response time.

Implemented features include:

- Method-aware caching: only `GET` is eligible for cache lookup/storage.
- An LRU cache abstraction with cache variants for `Vary` headers.
- Handling for `Cache-Control`, `ETag`, and `Vary` response headers.
- Cache management and statistics endpoints.
- Pino structured request/error logging, rate limiting, origin timeouts, header sanitization, and graceful shutdown.
- Docker and Docker Compose definitions, with a Redis container prepared for a future cache backend.
- Jest unit/integration tests, ESLint/Prettier, and a GitHub Actions workflow.

At a high level, a client request passes through Express middleware, reaches a management endpoint or the wildcard proxy route, and is handled by `HandleRequest`. A fresh cache entry is returned locally; otherwise the controller fetches from the origin, decides whether the response can be stored, and returns the origin response.

## 2. High-Level Architecture

```text
Client
  |
  v
Express server (server.js)
  |
  +-- pino-http request logging -------------------+--> JSON logs
  +-- express-rate-limit                            |
  +-- express.json()                                |
  v                                                 |
routes/route.js                                     |
  |                                                  |
  +-- GET /health, /cache/stats, DELETE /cache...   |
  +-- router.all('/{*path}')                         |
  v                                                  |
controllers/HandleRequest.js                         |
  |                                                  |
  +-- GET: cache.get(base key, request headers) ---> config/CatchMap.js
  |       |                                           |
  |       +-- in-memory LRUCache (max 100)           |
  |                                                   |
  +-- MISS / BYPASS: native fetch() ----------------> ORIGIN_URL
  |              (sanitized headers + timeout)       |
  v                                                  |
Express centralized error middleware ----------------+--> error log / 500 or 504

Docker Compose (prepared infrastructure)
  proxy container <---- default Compose network ----> redis:7-alpine container
                                                       ^
                                                       | REDIS_URL is supplied,
                                                       | but app code does not use it yet
```

### Components and communication

- **Client:** Calls ProxyCache's HTTP API.
- **Express server:** `server.js` creates the app, installs middleware, mounts routes, listens on `PORT`, and handles process signals.
- **Routes:** `routes/route.js` handles health/cache-management paths before forwarding all other paths to `HandleRequest`.
- **Controller:** `controllers/HandleRequest.js` implements proxying, caching decisions, conditional ETag requests, response-header forwarding, and statistics.
- **Cache abstraction:** `config/CatchMap.js` exports a default cache and a `createCache` factory. Callers use `get`, `set`, `has`, `delete`, `clear`, and `size`, rather than importing `lru-cache` directly.
- **In-memory LRU:** The default cache wraps `LRUCache` from `lru-cache` with `max: 100`.
- **Origin server:** `config/origin.js` reads `ORIGIN_URL`, defaulting to `http://dummyjson.com`.
- **Configuration:** `dotenv` loads `.env` before other imports. `.env.example` lists documented settings.
- **Logging/error handling:** `pino-http` logs completed requests; centralized Express error middleware logs request-context errors.
- **Rate limiting:** `express-rate-limit` applies to all mounted paths, including management routes.
- **Docker/Redis:** Redis is started by Compose but is **prepared but not currently wired** into `CatchMap.js` or any application code.
- **Tests:** Unit tests exercise a separately created cache; integration tests mount the router in a test app and mock the origin with Nock.

## 3. Request Lifecycle

### Management request

1. A client connects to the Express server.
2. `pino-http` attaches a request logger and will emit a structured completion log.
3. The rate limiter checks the client against `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`. Requests over the limit receive the middleware's normal `429` response.
4. `express.json()` parses JSON request bodies when relevant.
5. A route such as `GET /health` or `GET /cache/stats` responds directly; it does not call the origin or cache controller.

### Proxied GET request

1. The wildcard route `router.all('/{*path}', HandleRequest)` receives a path not claimed by a management endpoint.
2. `HandleRequest` creates `GET:${req.originalUrl}`. `originalUrl` includes the path and query string.
3. It calls `cache.get(cacheKey, req.headers)`. The cache considers the base key and, if the response varied by request header, only returns a matching variant.
4. If the entry is fresh and was not marked `noCache`, the controller increments `hits`, sets `X-Cache: HIT`, copies stored end-to-end response headers, and sends the stored status/body.
5. Otherwise it calls `fetchOrigin`. If a stale entry has an ETag, the request includes `if-none-match: <etag>`.
6. `fetchOrigin` removes blocked headers, uses native Node `fetch`, and aborts the request/body read after `ORIGIN_TIMEOUT_MS` (default 10 seconds).
7. A `304 Not Modified` with an existing entry updates its selected metadata and returns the stored body as `X-Cache: HIT`.
8. For another origin response, the controller reads its body, parses relevant caching headers, may store it, increments `misses`, copies allowed response headers, sets `X-Cache: MISS`, and returns the origin status/body.
9. Pino logs the completed request. Its request information includes method, URL, status/response time supplied by `pino-http`, and the `X-Cache` value exposed as `cacheStatus`.

### Proxied non-GET request

1. The controller immediately calls `forwardToOrigin`; it does not look up or write the cache.
2. The outgoing request is sanitized and timeout-protected in the same way as a GET.
3. The origin response is forwarded with `X-Cache: BYPASS`.

### Failure path

An exception from body parsing or the async controller reaches the error middleware in `server.js` (Express 5 propagates rejected async route handlers). `AbortError` becomes HTTP `504`; other errors become HTTP `500`. The middleware logs the error with method, URL, and selected status.

## 4. Cache Architecture

### Interface and backend

`config/CatchMap.js` contains `createCache({ max = 100, ttl = 0 } = {})`. The default exported instance is created without arguments, so its actual capacity is 100 and its library-level TTL is disabled (`0`). The factory exists to isolate callers from `lru-cache` and to make cache-specific tests possible.

| Member                     | Actual behavior                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `get(key, headers)`        | Finds the variants registered for `key`, returns the one whose `Vary` dimensions match the supplied request headers, or `undefined`. |
| `has(key, headers)`        | Boolean wrapper around `get`. The controller currently calls `get` directly.                                                         |
| `set(key, entry, headers)` | Builds a variant key, stores `entry` in `LRUCache`, and records it in the base-key variant index.                                    |
| `delete(key)`              | Deletes all variants of a base key and returns whether it found the base key.                                                        |
| `clear()`                  | Clears the LRU store and its variant index.                                                                                          |
| `size`                     | Returns the current `LRUCache.size`.                                                                                                 |

The default cache key starts as `GET:${req.originalUrl}`. A stored variant is internally extended with serialized values of the headers named in the origin `Vary` header. For example, a response with `Vary: Accept-Language` gets distinct entries for requests with different `accept-language` values.

### TTL and eviction

Two different timing concepts exist:

- **Library TTL:** `createCache({ ttl: 20 })` is tested and expires LRU entries after 20 ms. The production default does not set this option.
- **HTTP freshness:** `HandleRequest` stores `expiresAt` based on origin `Cache-Control: max-age`. It decides whether an entry is fresh with `isFresh(entry)`. This is the timing mechanism used by the actual proxy.

The LRU backend evicts least-recently-used entries after 100 stored variants. This bounds the main response store's memory. A recent `get` marks that entry as recently used.

### Cache eligibility, HIT/MISS/BYPASS, and invalidation

- Only successful (`response.ok`, normally 2xx) `GET` origin responses may be stored.
- `POST`, `PUT`, `DELETE`, `PATCH`, and every other non-GET method bypass the cache.
- `no-store` responses and responses with `Vary: *` are not stored.
- Responses that are not stored still return `X-Cache: MISS` for GET because an origin fetch occurred. `BYPASS` specifically means a non-GET method.
- `DELETE /cache` clears all entries.
- `DELETE /cache/:key` deletes a base key and all its variants. The handler prefixes `GET:` if it is absent. Since a URL key commonly contains `/`, encode it in the URL, for example `DELETE /cache/%2Fproducts%2F1`.
- `GET /cache/stats` returns process-local `{ hits, misses, size }`.

### Redis replacement

Redis is useful for sharing cache entries across multiple proxy instances and retaining them independently of one Node process. The current abstraction narrows the change: a Redis-backed object would need compatible `get`, `set`, `has`, `delete`, `clear`, and `size` behavior, including variant indexing. However, no Redis client is installed, `REDIS_URL` is not read, and the current implementation is **not Redis-enabled**.

## 5. HTTP Caching Semantics

This section distinguishes what the controller implements from normal HTTP caching features it does not implement.

| Header/condition           | Implemented behavior                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cache-Control: no-store`  | The response is forwarded but never stored.                                                                                                                                                                                         |
| `Cache-Control: no-cache`  | The response may be stored, but it is never served directly as fresh because `entry.noCache` is true. On a later request, the proxy fetches again and sends `If-None-Match` when an ETag exists.                                    |
| `Cache-Control: max-age=N` | `expiresAt` becomes current time plus `N` seconds. Before that time, a normal cached entry is a HIT.                                                                                                                                |
| No `max-age`               | The entry is stored with `expiresAt: 0`, immediately stale. If it has an ETag, it can be conditionally revalidated; otherwise a later request fetches a full response again.                                                        |
| `ETag`                     | Stored as `entry.etag`; a stale/no-cache entry adds lower-case `if-none-match` to the origin request. A `304` returns the cached body and refreshes `max-age` only if a parseable `max-age` is supplied by the 304/fallback policy. |
| `Vary`                     | Header names are lower-cased and become variant dimensions. Same URL plus different matching request header values uses different entries.                                                                                          |
| `Vary: *`                  | Not cached.                                                                                                                                                                                                                         |
| Other response headers     | The proxy copies response headers except its blocked hop-by-hop set and `content-length`; cached responses retain allowed headers as an object.                                                                                     |

Not implemented: `s-maxage`, `private`, `must-revalidate`, `stale-while-revalidate`, `Last-Modified`/`If-Modified-Since`, heuristic freshness, request-side cache directives, cache-control parsing beyond simple comma-separated directives, and shared-cache authentication policy. Do not claim these are supported in an interview.

## 6. Project Directory Structure

```text
ProxyCache/
├── server.js                         Express entry point and process lifecycle
├── package.json                      Scripts and dependencies
├── package-lock.json                 Locked npm dependency graph
├── README.md                         User-facing project overview
├── CONTRIBUTING.md                   Contribution workflow
├── ARCHITECTURE.md                   This implementation guide
├── Dockerfile                        Node 20 Alpine container image
├── docker-compose.yml                Proxy + prepared Redis infrastructure
├── .env.example                      Environment variable template
├── .gitignore                        Ignores node_modules and .env
├── .dockerignore                     Keeps local/development files out of image context
├── .eslintrc.json                    ESLint rules and Node/Jest environment
├── .prettierrc.json                  Prettier style settings
├── config/
│   ├── CatchMap.js                   Cache factory and default in-memory LRU adapter
│   ├── logger.js                     Pino logger instance
│   └── origin.js                     Reads ORIGIN_URL with a default
├── controllers/
│   └── HandleRequest.js              Proxy, caching, headers, timeout, metrics logic
├── routes/
│   └── route.js                      Management endpoints and wildcard proxy route
├── test/
│   ├── cache.test.js                 Cache-unit tests
│   └── handle-request.integration.test.js  Router/controller integration tests
└── .github/workflows/
    └── ci.yml                        GitHub Actions lint/test workflow
```

There are no migrations, database schema files, Redis client configuration files, or separate middleware directory in the current repository.

## 7. Important Code Components

### `server.js`

**Responsibility:** Application entry point. It calls `require('dotenv').config()`, constructs Express, installs middleware, mounts `proxyRoutes`, registers the error handler, and starts listening.

**Dependencies:** `express`, `express-rate-limit`, `pino-http`, `./routes/route`, and `./config/logger`.

**Important logic:** `pinoHttp` uses the shared logger and its `customProps` derives `cacheStatus` from `X-Cache`. Rate limiting defaults to 100 requests per 60 seconds if environment values are absent/invalid. The final middleware maps `AbortError` to 504 and other errors to 500. `shutdown(signal)` calls `server.close` for `SIGTERM` and `SIGINT`.

**Design note:** This file starts the server immediately and does not export `app` or `server`; integration tests therefore construct a small Express app themselves and mount the router.

### `routes/route.js`

**Responsibility:** Defines the public API routing order.

**Inputs/outputs:** It calls controller/cache functions and sends Express responses. Specific management routes come before the wildcard route, so `/health` is not proxied.

**Important logic:** `DELETE /cache/:key` uses `decodeURIComponent` then normalizes to a `GET:` base key. The named wildcard `/{*path}` is Express 5-compatible and catches the root path as well.

### `controllers/HandleRequest.js`

**Responsibility:** Contains the proxy policy.

| Function                          | Role                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `HandleRequest(req, res)`         | GET cache lookup, revalidation, storage, response, and hit/miss metrics.                  |
| `forwardToOrigin(req, res)`       | Forwards non-GET requests and marks `BYPASS`.                                             |
| `fetchOrigin(req, extraHeaders)`  | Sanitizes headers, applies `AbortController`, calls native `fetch`, then reads text body. |
| `parseCacheControl(value)`        | Parses simple lower-cased Cache-Control directives.                                       |
| `varyFields(value)`               | Produces lower-case Vary field names; safely handles `null`.                              |
| `sanitizeRequestHeaders(headers)` | Removes static blocked headers plus token names listed by request `Connection`.           |
| `copyHeaders` / `sendCached`      | Copy permitted headers to live/cached responses.                                          |
| `getCacheStats()`                 | Returns `{ hits, misses, size }`.                                                         |

**Outputs:** A proxied response, a cached response, or a rejected promise for centralized error handling.

### `config/CatchMap.js`

**Responsibility:** Cache adapter. It owns the internal LRU store and a `Map` from a base key to its variant keys.

**Why:** The controller is not coupled to `LRUCache` methods/options. A later backend can preserve the same logical interface.

### `config/origin.js` and `config/logger.js`

- `origin.js` exports `process.env.ORIGIN_URL || 'http://dummyjson.com'`. It is evaluated when required, after dotenv has loaded in the normal server startup path.
- `logger.js` creates a Pino logger with `LOG_LEVEL` or `info`.

## 8. API Documentation

All endpoints are rate-limited by the global middleware. The proxy route handles every otherwise-unmatched method/path.

### `GET /health`

- **Purpose:** Lightweight process/cache health information.
- **Response:** `200` JSON, e.g. `{"status":"ok","uptime":42,"cache":{"backend":"memory","status":"ok","size":3}}`.
- **Caching:** No controller caching; no `X-Cache` is set.
- **Example:** `curl http://localhost:4000/health`

### `GET /cache/stats`

- **Purpose:** Returns in-process cache counters.
- **Response:** `200` JSON, e.g. `{"hits":4,"misses":9,"size":2}`.
- **Caching:** Not cached; counters reset on process restart.
- **Example:** `curl http://localhost:4000/cache/stats`

### `DELETE /cache`

- **Purpose:** Purges all in-memory cache entries and variant metadata.
- **Response:** `204 No Content`.
- **Caching:** Management action, not proxied/cached.
- **Example:** `curl -i -X DELETE http://localhost:4000/cache`

### `DELETE /cache/:key`

- **Purpose:** Purges every variant under one base GET key.
- **Request:** `:key` may include `GET:` or omit it; URL-encode slash-containing paths.
- **Responses:** `204 No Content` if the base key exists; `404` if it does not.
- **Caching:** Management action, not proxied/cached.
- **Example:** `curl -i -X DELETE 'http://localhost:4000/cache/%2Fproducts%2F1'`

### Proxy endpoint: `ANY /{*path}`

- **Purpose:** Forwards the matched method/path/query to `ORIGIN_URL + req.originalUrl`.
- **Request:** Headers are sanitized; JSON bodies are parsed by Express and serialized with `JSON.stringify` for non-GET/HEAD methods.
- **Responses:** Origin status/body with allowed origin headers. GET responses add `X-Cache: HIT` or `MISS`; non-GET responses add `X-Cache: BYPASS`. An origin timeout becomes `504 {"error":"Origin request timed out"}`; other thrown failures become `500 {"error":"Internal Server Error"}`.
- **Caching:** Only GET responses meeting the conditions in section 5 are stored.
- **Examples:**

  ```bash
  curl -i http://localhost:4000/products/1
  curl -i -X POST http://localhost:4000/products/add \
    -H 'Content-Type: application/json' -d '{"title":"Example"}'
  ```

## 9. Cache HIT / MISS / BYPASS

`X-Cache` describes the proxy path used for a proxied response.

```text
First eligible GET
Client -> Proxy -> cache lookup (no fresh match) -> Origin -> maybe cache.set -> Client
                     X-Cache: MISS

Second eligible GET within max-age
Client -> Proxy -> cache lookup (fresh matching entry) -> Client
                     X-Cache: HIT

POST / PUT / DELETE / PATCH
Client -> Proxy -> no cache lookup -> Origin -> Client
                     X-Cache: BYPASS
```

Important nuance: a GET whose origin response says `no-store` is not retained, but its first response is still labelled `MISS`, not `BYPASS`. A stale ETag entry receiving a 304 is served from its stored body and labelled `HIT`.

## 10. Error Handling

Possible failures include malformed JSON handled by Express, failed DNS/network/origin connections, an origin body that hangs, and unexpected controller errors.

- `fetchOrigin` lets failures throw instead of producing scattered controller-level responses.
- Its abort timer covers both `fetch` and `response.text()` because the timer is cleared only in `finally` after the body is read.
- The error middleware identifies `err.name === 'AbortError'` and returns `504` with `Origin request timed out`.
- Other errors return `500` with `Internal Server Error`.
- `req.log.error` records the error object, method, `originalUrl`, and status. The regular Pino HTTP completion log also records the request outcome.
- Origin HTTP error responses (for example 404/500 returned by the origin) are not thrown by `fetch`; they are proxied with their original status/body and are not cached because `response.ok` is false.

## 11. Security and Reliability

### Implemented protections

- **Rate limiting:** Configurable in-process limit reduces accidental or simple abusive request bursts.
- **Header sanitization:** `sanitizeRequestHeaders` removes `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `host`, and `content-length`, plus any names named by the client `Connection` header. It avoids forwarding connection-specific data upstream.
- **Response header filtering:** The same blocked set and `content-length` are not copied back. Express recalculates body length.
- **Timeout:** `AbortController` prevents an indefinitely slow origin from holding the request forever.
- **Environment configuration:** `.env` is ignored by Git and `.env.example` documents safe defaults.
- **Graceful shutdown:** SIGTERM/SIGINT call `server.close`, allowing existing server connections to finish before process exit.

### Current Limitations / Potential Improvements

- The cache, metrics, and rate-limit state are local to one Node process; neither shared nor persistent.
- Redis is **prepared but not currently wired**. `REDIS_URL` in Compose has no effect on application behavior.
- No authentication/authorization protects purge and statistics endpoints.
- No `trust proxy` configuration exists, so rate limiting may use proxy IPs incorrectly behind a reverse proxy.
- No forced graceful-shutdown deadline exists; a permanently open request can delay `server.close` indefinitely.
- Proxying is JSON-oriented for non-GET bodies; multipart, streaming uploads, raw binary bodies, and streaming origin responses are not faithfully passed through.
- The cache's `variants` map is not pruned when `LRUCache` silently evicts/TTL-expires an entry. `size` remains correct because it reads LRU, but stale variant-key references can accumulate until that base key is deleted/cleared.
- No automated tests currently cover `no-store`, `no-cache`, ETag revalidation, Vary variants, timeout handling, rate limiting, health/cache management endpoints, graceful shutdown, or header sanitization.

## 12. Observability

`config/logger.js` supplies Pino structured logs at `LOG_LEVEL` (default `info`). `pino-http` emits a log for each completed Express request; it sees request method, URL, response status, and response time through its normal serializer/output, while `customProps` adds `cacheStatus` from `X-Cache` (or `N/A` for management/rate-limit paths).

When an error reaches the final middleware, `req.log.error` includes the error and explicit method, URL, and chosen status. This makes an origin outage distinguishable from a 504 timeout and helps correlate an incident with a particular route.

Operational checks:

- `/health` shows process uptime and current cache backend/size.
- `/cache/stats` shows total in-process hit/miss counts and LRU size.

For a production issue, a rising miss count may indicate short max-age values, variant fragmentation, or eviction; a rising 504 rate points to a slow origin; and logs with `BYPASS` distinguish write traffic from cacheable reads.

## 13. Docker and Deployment Architecture

`Dockerfile` uses `node:20-alpine`, sets `/app`, copies package manifests, runs `npm ci --omit=dev`, copies the application, sets `NODE_ENV=production`, exposes 4000, and runs `npm start`.

`docker-compose.yml` defines:

- **proxy:** Built from the repository, publishes `4000:4000`, supplies `PORT`, `ORIGIN_URL`, and `REDIS_URL`, and declares `depends_on: redis`.
- **redis:** Uses `redis:7-alpine` and publishes `6379:6379`.

Compose creates its default private network, so the proxy could reach Redis at hostname `redis`. This is infrastructure readiness only: the running Node code does not import a Redis package, read `REDIS_URL`, or issue Redis commands. Also, `depends_on` controls startup ordering, not application-level health readiness.

In a real production deployment, set the environment variables through the deployment platform/secret manager, avoid publishing Redis publicly unless needed, add a Redis client and connection/health handling, and run multiple proxy replicas only after moving cache/metrics coordination out of process memory.

## 14. Testing Architecture

The project uses Jest (`npm test` runs `jest --runInBand`). Running in band keeps tests deterministic around shared module-level cache state.

### Unit tests: `test/cache.test.js`

These import `createCache` and verify:

- set/get/has/delete;
- library-level TTL expiry with a 20 ms test cache;
- LRU behavior by using `max: 2`, touching one key, then inserting a third.

### Integration tests: `test/handle-request.integration.test.js`

These mount the real router on a small Express test app, use Supertest to make HTTP requests, and use Nock 14 to mock `http://dummyjson.com`. They verify:

- first cacheable GET returns `MISS`, second returns `HIT`;
- POST, PUT, and DELETE return `BYPASS`;
- a mocked unreachable origin reaches the test app's error middleware and returns 500.

The test app has its own minimal error middleware because `server.js` starts listening immediately and does not export its app. That is sufficient for the tested controller path, but it does not test the exact production logger/error middleware object.

### Quality tools

- `npm run lint` executes `eslint . && prettier --check .`.
- `.eslintrc.json` enables Node/Jest/ES2022, extends `eslint:recommended` and Prettier, and prohibits `console`.
- `.prettierrc.json` selects single quotes, no trailing commas, and 100-column width.

Unit tests isolate cache behavior; integration tests prove router/controller/origin interaction. Both are needed: a passing cache unit test alone would not prove the proxy assigns the right cache status or forwards non-GET methods correctly.

## 15. CI/CD

`.github/workflows/ci.yml` contains one GitHub Actions job named `test`.

- It triggers on every `push` and `pull_request`.
- It checks out the repository, uses Node 20, and enables npm cache.
- It runs `npm install`, `npm run lint`, and `npm test`.

There is no deployment, artifact publishing, coverage threshold, security scan, Docker build, or release workflow configured. The workflow uses `npm install`, not `npm ci`.

## 16. Design Decisions

- **Cache abstraction:** Separates controller policy from storage mechanics. It reduces the surface area for a later Redis migration.
- **LRU cache:** Gives fast local reads while bounding the main cache to 100 entries. Recently used responses are more likely to be useful again.
- **Method-aware caching:** Caching only GET prevents a write from being served as a stale cached result and avoids caching unsafe methods.
- **HTTP headers drive freshness:** `no-store`, `no-cache`, `max-age`, ETag, and Vary make cache behavior follow origin intent rather than a global arbitrary TTL.
- **Redis as a future backend:** Useful once there are multiple instances or a need for shared/persistent state, but deliberately not added to the simple current runtime.
- **Rate limit:** Protects the proxy and origin from bursts, though a distributed store would be needed for multi-instance consistency.
- **Request timeout:** Converts an unresponsive upstream into a bounded failure instead of consuming connections indefinitely.
- **Structured logging:** JSON logs are easier to search/aggregate and can expose cache behavior and latency per request.
- **Graceful shutdown:** Lets a container/process manager stop the service without immediately dropping accepted connections.

## 17. Trade-offs

| Choice                            | Benefit                                | Cost                                                              |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| In-memory LRU                     | Very simple and low-latency            | Lost on restart; no sharing across replicas; limited memory.      |
| Max 100 entries                   | Predictable primary-cache memory usage | Working set larger than 100 will churn/evict.                     |
| Origin-controlled `max-age`       | Better correctness/freshness semantics | More misses/revalidations for conservative origins.               |
| Store no-cache/stale ETag entries | Can save body transfer after 304       | Still needs an origin round-trip; metadata logic is more complex. |
| JSON buffering                    | Easy to handle/cache response bodies   | Not suitable for large streaming responses/uploads.               |
| One Express process               | Easy to understand and deploy          | No fault isolation or horizontal state coordination.              |
| Compose Redis readiness           | Shows intended deployment direction    | May misleadingly look active unless documented as unwired.        |

## 18. Example End-to-End Scenario

Assume `ORIGIN_URL=http://dummyjson.com` and the origin responds to `GET /products/1` with `200`, JSON body, `Cache-Control: max-age=60`, and `ETag: "p1"`.

1. The client calls `GET http://localhost:4000/products/1`.
2. Pino request middleware starts observing it; the rate limiter permits it; JSON middleware has nothing to parse.
3. The wildcard route calls `HandleRequest`.
4. The base key is `GET:/products/1`. There is no matching cache entry, so this is a miss path.
5. `fetchOrigin` removes connection/host/content-length-style headers, starts its abort timer, and calls the origin with the GET path.
6. The controller reads the body and sees a successful response. It parses `max-age=60`, records the ETag, stores allowed response headers/body/status with an `expiresAt` 60 seconds in the future, and registers any Vary dimensions.
7. It increments `misses`, copies allowed origin headers, sets `X-Cache: MISS`, and returns 200/body.
8. The completion log records the request, including cache status and elapsed response time.

When the client immediately repeats the same GET with the same relevant Vary request headers:

1. The same base/variant lookup returns the entry.
2. `isFresh` is true and `noCache` is false.
3. The controller increments `hits`, sets `X-Cache: HIT`, copies stored allowed headers, and sends the stored body. No origin request occurs.

After 60 seconds, the entry is stale. The next request sends `if-none-match: "p1"`; a 304 causes ProxyCache to use the stored body and report `HIT`, while a changed 200 replaces the stored entry and reports `MISS`.

## 19. Interview Explanation

### 30-second explanation

“ProxyCache is an Express-based HTTP proxy that sits in front of an origin API. It caches safe GET responses in a bounded LRU cache and uses the origin's Cache-Control, ETag, and Vary headers so the cache does not ignore HTTP semantics. I also added operational pieces such as Pino logs, rate limiting, origin timeouts, cache purge/stats endpoints, Docker, and Jest tests.”

### 1-minute explanation

“I built ProxyCache to understand the layer between clients and an API origin. Every request first goes through Express logging and rate limiting. GET requests are checked in an in-memory LRU cache using the URL and any Vary headers. A fresh match is returned as a HIT. Otherwise I call the origin with sanitized headers and a timeout. I store successful responses only when the headers allow it; for example no-store is never cached, max-age controls freshness, and ETags let stale entries be conditionally validated. Non-GET methods bypass the cache because they may change state. The cache layer is an adapter, so Redis is the next logical backend for multi-instance deployment; Compose already starts Redis, although I would be clear that it is not connected yet.”

### 2-minute technical explanation

“The entry point loads dotenv, installs pino-http, express-rate-limit, JSON parsing, routes, and one centralized error handler. The routes expose health and cache-management endpoints before an Express 5 wildcard proxy route. In `HandleRequest`, non-GET goes directly to `forwardToOrigin`, which returns `X-Cache: BYPASS`. For GET, I build `GET:${originalUrl}` and ask the cache adapter for a variant matching request headers. The adapter wraps lru-cache with a max of 100 and tracks variants separately for Vary.

If the entry is fresh according to its stored max-age and isn't no-cache, I send the stored status, body, and safe headers with `X-Cache: HIT`. Otherwise I use native fetch with AbortController and strip hop-by-hop plus host and content-length headers. If an old entry has an ETag, I send If-None-Match. A 304 lets me send the existing body; a new successful response is stored unless no-store or Vary star blocks it. I expose hits, misses, and cache size, plus full/specific purge endpoints.

The application logs structured requests and errors, rate limits all paths, and closes the HTTP server on SIGINT or SIGTERM. The test suite has cache unit tests and Nock/Supertest integration tests. The main scaling limitation is that cache, stats, and limiting are all in process. Redis in Compose is only infrastructure readiness today, so wiring a Redis-compatible cache adapter and distributed rate limiting would be my next steps.”

## 20. Interview Questions You Should Be Ready For

1. **Why cache only GET?**
   **Testing:** HTTP safety/idempotency.
   **Answer:** “GET is the read path this project treats as cacheable. POST, PUT, DELETE, and PATCH can change origin state, so serving them from a previous response would be incorrect. They take the BYPASS path.”
   **Relevant:** `controllers/HandleRequest.js`.

2. **Why use LRU?**
   **Testing:** Eviction strategy.
   **Answer:** “The cache must have a bound. LRU keeps recently accessed entries when the 100-entry capacity is reached, which is a practical default for repeated read traffic.”
   **Relevant:** `config/CatchMap.js`.

3. **What is the difference between library TTL and HTTP max-age here?**
   **Testing:** Accurate code understanding.
   **Answer:** “The factory supports lru-cache TTL for isolated tests, but production uses no library TTL. The controller records `expiresAt` from the origin's max-age so it can keep stale data available for ETag revalidation.”
   **Relevant:** `config/CatchMap.js`, `controllers/HandleRequest.js`.

4. **How is a cache key formed?**
   **Testing:** Cache correctness.
   **Answer:** “The base is `GET:${req.originalUrl}`, including query string. For Vary, the adapter appends named request-header values to form a variant key.”
   **Relevant:** both cache/controller files.

5. **How does invalidation work?**
   **Testing:** Operational cache control.
   **Answer:** “`DELETE /cache` clears everything. `DELETE /cache/:key` normalizes a GET base key and deletes all its variants. A caller should URL-encode path slashes.”
   **Relevant:** `routes/route.js`.

6. **How do you honor `no-store` and `no-cache`?**
   **Testing:** HTTP semantics.
   **Answer:** “No-store is forwarded but never put in cache. No-cache can be stored but is not served directly; the next request must go back to the origin, preferably conditionally with ETag.”
   **Relevant:** `HandleRequest`.

7. **How does ETag revalidation work?**
   **Testing:** Conditional requests.
   **Answer:** “I save the ETag. For stale/no-cache entries I add If-None-Match. If the origin sends 304, I reuse the saved body and refresh supported metadata.”
   **Relevant:** `HandleRequest`.

8. **Why do you need Vary?**
   **Testing:** Variant correctness.
   **Answer:** “A URL alone is not always enough. If an origin varies by Accept-Language, clients with different language headers must not receive each other's cached response.”
   **Relevant:** `varyFields`, `variantKey`.

9. **What happens when the origin is unreachable?**
   **Testing:** Failure propagation.
   **Answer:** “Fetch rejects and Express 5 sends the rejection to the central error middleware. It logs context and responds 500 unless it is an AbortError.”
   **Relevant:** `server.js`, controller.

10. **What happens on a slow origin?**
    **Testing:** Async timeout design.
    **Answer:** “An AbortController timer defaults to 10 seconds and covers fetch plus body read. AbortError is converted to a 504.”
    **Relevant:** `fetchOrigin`, `server.js`.

11. **Why sanitize headers?**
    **Testing:** Proxy protocol awareness.
    **Answer:** “Hop-by-hop headers describe one network connection and must not be relayed. I also remove client host/content-length because the proxy constructs a new upstream request.”
    **Relevant:** `sanitizeRequestHeaders`.

12. **How is rate limiting configured?**
    **Testing:** Middleware/configuration.
    **Answer:** “express-rate-limit is global. It uses RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX, defaulting to 60 seconds and 100 requests.”
    **Relevant:** `server.js`, `.env.example`.

13. **Why Pino instead of console logs?**
    **Testing:** Observability.
    **Answer:** “Pino outputs structured data that log tools can query. pino-http adds request completion details and I add the cache outcome.”
    **Relevant:** `config/logger.js`, `server.js`.

14. **What does graceful shutdown do here?**
    **Testing:** Node operations.
    **Answer:** “SIGINT/SIGTERM trigger server.close so the listener stops accepting connections and existing ones can finish. There is no forced deadline yet.”
    **Relevant:** `shutdown` in `server.js`.

15. **Is Redis used today?**
    **Testing:** Honesty about infrastructure.
    **Answer:** “No. Docker Compose starts Redis and sets REDIS_URL, but no code imports a Redis client or reads that setting. It is preparation only.”
    **Relevant:** `docker-compose.yml`, `CatchMap.js`.

16. **How would you scale this horizontally?**
    **Testing:** Distributed systems.
    **Answer:** “Replace the in-memory adapter with a Redis-compatible one, move rate limits to a shared store, centralize metrics, and configure trust proxy/load balancing. The current cache is per process.”
    **Relevant:** cache abstraction, Compose.

17. **What race conditions could occur?**
    **Testing:** Concurrency.
    **Answer:** “Multiple simultaneous misses for the same key can each fetch the origin because there is no request coalescing. A future single-flight map could deduplicate them.”
    **Relevant:** `HandleRequest`.

18. **How are tests split?**
    **Testing:** Test strategy.
    **Answer:** “Cache tests isolate adapter behavior, while Supertest/Nock integration tests use real routes/controller flow but mock the external origin. That gives fast focused checks and behavior-level confidence.”
    **Relevant:** `test/`.

19. **What does CI do?**
    **Testing:** Delivery discipline.
    **Answer:** “On every push and PR, Actions uses Node 20, installs packages, runs lint/Prettier checks, and runs Jest. It does not deploy or build Docker yet.”
    **Relevant:** `.github/workflows/ci.yml`.

20. **What responses are cached?**
    **Testing:** Exact behavior.
    **Answer:** “Only GET origin responses where `response.ok` is true, no-store is absent, and Vary is not star. max-age controls direct freshness.”
    **Relevant:** `HandleRequest`.

21. **What metrics are available?**
    **Testing:** Operations.
    **Answer:** “`GET /cache/stats` returns process-local hits, misses, and LRU size; `/health` returns uptime and cache backend/status/size. Logs also show per-request cache status and latency.”
    **Relevant:** route/controller/server files.

22. **What does the proxy not support yet?**
    **Testing:** Trade-offs and roadmap.
    **Answer:** “It does not stream bodies, share state across instances, authenticate management endpoints, or cover all HTTP cache directives. Redis is not connected yet.”
    **Relevant:** sections 5 and 11.

## 21. Know Your Code Cheat Sheet

| Topic           | Remember this                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point     | `server.js`: dotenv, middleware order, error handler, listener, shutdown.                                                                          |
| Routing         | `routes/route.js`: management paths first, then `router.all('/{*path}')`.                                                                          |
| Main controller | `HandleRequest`: GET HIT/MISS/revalidation; `forwardToOrigin`: non-GET BYPASS.                                                                     |
| Cache           | `config/CatchMap.js`: default in-memory LRU, max 100, Vary variants, `createCache`.                                                                |
| Origin          | `ORIGIN_URL` is read in `config/origin.js`; default is DummyJSON.                                                                                  |
| Timeout         | `ORIGIN_TIMEOUT_MS`, default 10,000 ms; AbortError maps to 504.                                                                                    |
| Rate limit      | `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`; defaults 60,000 / 100.                                                                                  |
| Observability   | Pino + pino-http; `X-Cache` becomes `cacheStatus`; `/health`, `/cache/stats`.                                                                      |
| Endpoints       | Health, cache stats, full purge, single-key purge, wildcard proxy.                                                                                 |
| Cache labels    | `HIT` = fresh/local or 304-validated; `MISS` = GET origin path; `BYPASS` = non-GET origin path.                                                    |
| Dependencies    | Express/server; lru-cache/storage; dotenv/config; pino/logging; express-rate-limit/protection; Jest/Supertest/Nock/tests; ESLint/Prettier/quality. |
| Docker          | Dockerfile runs Node 20 Alpine; Compose starts proxy + Redis, but Redis is unwired.                                                                |
| Common failures | Origin network error -> 500; origin timeout -> 504; rate limit -> 429; no fresh cache/variant -> origin fetch.                                     |

## Architecture Findings & Recommendations

1. **Redis is not integrated.** The Compose service and `REDIS_URL` may make it look active, but no application code uses Redis. Label it as planned readiness until a real adapter/client exists.
2. **Cache semantics are partially, not fully, HTTP-complete.** The implemented directives are useful, but only `no-store`, `no-cache`, `max-age`, ETag, and Vary are covered. Add tests before extending policy.
3. **The variant index can retain stale references.** LRU eviction/TTL expiration does not remove keys from the separate `variants` map. Add disposal hooks or cleanup when moving toward long-running production use.
4. **Management endpoints are open.** Add authentication/authorization or restrict them at the network layer before exposing the service publicly.
5. **Testing does not yet cover key production behavior.** Add tests for timeout/504, Vary, ETag/304, no-store/no-cache/max-age, rate limiting, header sanitization, and the real server error logger.
6. **The app is not exported for tests.** Extracting app construction from listening would let integration tests exercise exactly the production middleware chain without binding a port.
7. **Graceful shutdown should have a deadline.** Add connection tracking or a maximum drain timer so shutdown cannot wait forever.
