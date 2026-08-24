require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const proxyRoutes = require('./routes/route');
const logger = require('./config/logger');

const app = express();
const PORT = process.env.PORT || 4000;
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 100;

app.use(
  pinoHttp({
    logger,
    customProps: (req, res) => ({ cacheStatus: res.getHeader('X-Cache') || 'N/A' })
  })
);
app.use(
  rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(express.json());
app.use('/', proxyRoutes);

app.use((err, req, res, next) => {
  const status = err.name === 'AbortError' ? 504 : err.status || 500;
  req.log.error({ err, method: req.method, url: req.originalUrl, status }, 'Request failed');
  if (res.headersSent) return next(err);
  res
    .status(status)
    .json({ error: status === 504 ? 'Origin request timed out' : 'Internal Server Error' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Caching Proxy running');
});

const shutdown = (signal) => {
  logger.info({ signal }, 'Shutting down server');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Failed to close server');
      process.exitCode = 1;
    }
    process.exit();
  });
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
