const express = require('express');
const nock = require('nock');
const request = require('supertest');
const router = require('../routes/route');
const { cache } = require('../controllers/HandleRequest');

const app = express();
app.use(express.json());
app.use(router);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: 'Internal Server Error' });
});

describe('proxy request handling', () => {
  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });
  afterAll(() => nock.enableNetConnect());
  afterEach(() => {
    cache.clear();
    nock.cleanAll();
  });

  test('serves a GET cache miss followed by a cache hit', async () => {
    const origin = nock('http://dummyjson.com')
      .get('/products/1')
      .reply(200, { id: 1, title: 'Phone' }, { 'Cache-Control': 'max-age=60' });

    const miss = await request(app).get('/products/1').expect(200);
    const hit = await request(app).get('/products/1').expect(200);

    expect(miss.headers['x-cache']).toBe('MISS');
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body).toEqual({ id: 1, title: 'Phone' });
    expect(origin.isDone()).toBe(true);
  });

  test.each(['post', 'put', 'delete'])('%s bypasses the cache', async (method) => {
    const origin = nock('http://dummyjson.com')
      [method]('/products/1')
      .reply(200, { method: method.toUpperCase() });

    const response = await request(app)
      [method]('/products/1')
      .send({ title: 'Updated' })
      .expect(200);

    expect(response.headers['x-cache']).toBe('BYPASS');
    expect(origin.isDone()).toBe(true);
  });

  test('passes an unreachable origin error to centralized error handling', async () => {
    nock('http://dummyjson.com').get('/unreachable').replyWithError('origin unavailable');

    const response = await request(app).get('/unreachable').expect(500);

    expect(response.body).toEqual({ error: 'Internal Server Error' });
  });
});
