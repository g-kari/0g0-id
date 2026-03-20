import { Hono } from 'hono';
import { fetchWithAuth, proxyResponse } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/services
app.get('/', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services`);
  return proxyResponse(res);
});

// GET /api/services/:id
app.get('/:id', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}`
  );
  return proxyResponse(res);
});

// POST /api/services
app.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: c.env.IDP_ORIGIN,
    },
    body: JSON.stringify(body),
  });
  return proxyResponse(res);
});

// PATCH /api/services/:id — allowed_scopesの更新
app.patch('/:id', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    }
  );
  return proxyResponse(res);
});

// DELETE /api/services/:id
app.delete('/:id', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}`,
    { method: 'DELETE', headers: { Origin: c.env.IDP_ORIGIN } }
  );
  return proxyResponse(res);
});

// GET /api/services/:id/redirect-uris
app.get('/:id/redirect-uris', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris`
  );
  return proxyResponse(res);
});

// POST /api/services/:id/redirect-uris
app.post('/:id/redirect-uris', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    }
  );
  return proxyResponse(res);
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete('/:id/redirect-uris/:uriId', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris/${c.req.param('uriId')}`,
    { method: 'DELETE', headers: { Origin: c.env.IDP_ORIGIN } }
  );
  return proxyResponse(res);
});

export default app;
