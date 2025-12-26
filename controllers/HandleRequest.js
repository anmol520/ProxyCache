const cache = require('../config/CatchMap');
const ORIGIN_URL = require('../config/origin');

const HandleRequest = async (req, res) => {
  const method = req.method;

  if (method !== 'GET') {
    return forwardToOrigin(req, res);
  }

  const cacheKey = `${method}:${req.originalUrl}`;

  if (cache.has(cacheKey)) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cache.get(cacheKey));
  }

  try {
    const targetUrl = ORIGIN_URL + req.originalUrl;
    const response = await fetch(targetUrl);

    const data = await response.json();

    cache.set(cacheKey, data);
    res.setHeader('X-Cache', 'MISS');

    return res.status(200).send(data);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Proxy Error');
  }
};

const forwardToOrigin = async (req, res) => {
  try {
    const targetUrl = ORIGIN_URL + req.originalUrl;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? null : JSON.stringify(req.body)
    });

    const data = await response.text();
    res.setHeader('X-Cache', 'BYPASS');

    return res.status(response.status).send(data);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Proxy Error');
  }
};

module.exports = { HandleRequest };

