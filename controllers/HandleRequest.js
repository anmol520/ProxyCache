const cache = require('../config/CatchMap');
const ORIGIN_URL = require('../config/origin');

const stats = { hits: 0, misses: 0 };
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

const cacheKeyFor = (req) => `GET:${req.originalUrl}`;
const parseCacheControl = (value = '') => {
  const directives = Object.create(null);
  for (const directive of value.toLowerCase().split(',')) {
    const [name, rawValue] = directive.trim().split('=');
    if (name) directives[name] = rawValue ? rawValue.replace(/^"|"$/g, '') : true;
  }
  return directives;
};
const varyFields = (value) =>
  (value || '')
    .split(',')
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
const isFresh = (entry) => entry.expiresAt === null || Date.now() < entry.expiresAt;

const sanitizeRequestHeaders = (headers) => {
  const connectionTokens = String(headers.connection || '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim());
  const blocked = new Set([...hopByHopHeaders, ...connectionTokens]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()))
  );
};
const copyHeaders = (headers, res) => {
  for (const [name, value] of headers) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length')
      res.setHeader(name, value);
  }
};
const sendCached = (res, entry) => {
  for (const [name, value] of Object.entries(entry.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length')
      res.setHeader(name, value);
  }
  return res.status(entry.status).send(entry.body);
};

const fetchOrigin = async (req, extraHeaders = {}) => {
  const timeoutMs = Number(process.env.ORIGIN_TIMEOUT_MS) || 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ORIGIN_URL + req.originalUrl, {
      method: req.method,
      headers: { ...sanitizeRequestHeaders(req.headers), ...extraHeaders },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: controller.signal
    });
    return { response, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
};

const HandleRequest = async (req, res) => {
  if (req.method !== 'GET') return forwardToOrigin(req, res);
  const cacheKey = cacheKeyFor(req);
  const cached = cache.get(cacheKey, req.headers);

  if (cached && isFresh(cached) && !cached.noCache) {
    stats.hits += 1;
    res.setHeader('X-Cache', 'HIT');
    return sendCached(res, cached);
  }

  const { response, body } = await fetchOrigin(
    req,
    cached?.etag ? { 'if-none-match': cached.etag } : {}
  );
  if (response.status === 304 && cached) {
    const directives = parseCacheControl(
      response.headers.get('cache-control') || cached.cacheControl
    );
    cached.cacheControl = response.headers.get('cache-control') || cached.cacheControl;
    cached.etag = response.headers.get('etag') || cached.etag;
    cached.noCache = Boolean(directives['no-cache']);
    cached.expiresAt = Number.isFinite(Number(directives['max-age']))
      ? Date.now() + Number(directives['max-age']) * 1000
      : cached.expiresAt;
    cache.set(cacheKey, cached, req.headers);
    stats.hits += 1;
    res.setHeader('X-Cache', 'HIT');
    return sendCached(res, cached);
  }

  const cacheControl = response.headers.get('cache-control') || '';
  const directives = parseCacheControl(cacheControl);
  const vary = varyFields(response.headers.get('vary'));
  const maxAge = Number(directives['max-age']);
  const canCache = response.ok && !directives['no-store'] && !vary.includes('*');
  if (canCache) {
    cache.set(
      cacheKey,
      {
        body,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        cacheControl,
        etag: response.headers.get('etag'),
        vary,
        noCache: Boolean(directives['no-cache']),
        expiresAt: Number.isFinite(maxAge) ? Date.now() + maxAge * 1000 : 0
      },
      req.headers
    );
  }
  stats.misses += 1;
  copyHeaders(response.headers, res);
  res.setHeader('X-Cache', 'MISS');
  return res.status(response.status).send(body);
};

const forwardToOrigin = async (req, res) => {
  const { response, body } = await fetchOrigin(req);
  copyHeaders(response.headers, res);
  res.setHeader('X-Cache', 'BYPASS');
  return res.status(response.status).send(body);
};

const getCacheStats = () => ({ hits: stats.hits, misses: stats.misses, size: cache.size });
module.exports = { HandleRequest, cache, getCacheStats };
