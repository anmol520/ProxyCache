const express = require('express');
const router = express.Router();

const { HandleRequest, cache, getCacheStats } = require('../controllers/HandleRequest');

router.get('/cache/stats', (req, res) => res.json(getCacheStats()));
router.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    cache: { backend: 'memory', status: 'ok', size: cache.size }
  })
);
router.delete('/cache', (req, res) => {
  cache.clear();
  res.status(204).end();
});
router.delete('/cache/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const deleted = cache.delete(key.startsWith('GET:') ? key : `GET:${key}`);
  res.status(deleted ? 204 : 404).end();
});

router.all('/{*path}', HandleRequest);

module.exports = router;
