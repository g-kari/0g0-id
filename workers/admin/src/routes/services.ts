import { Hono } from 'hono';
import { fetchWithAuth } from '@0g0-id/shared';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

// GET /api/services
app.get('/', async (c) => {
  const res = await fetchWithAuth(c, SESSION_COOKIE, `${c.env.IDP_ORIGIN}/api/services`);
  return c.json(await res.json(), res.status as 200);
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
  return c.json(await res.json(), res.status as 200);
});

// DELETE /api/services/:id
app.delete('/:id', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}`,
    { method: 'DELETE' }
  );
  if (res.status === 204) return c.body(null, 204);
  return c.json(await res.json(), res.status as 200);
});

// GET /api/services/:id/redirect-uris
app.get('/:id/redirect-uris', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris`
  );
  return c.json(await res.json(), res.status as 200);
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
  return c.json(await res.json(), res.status as 200);
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete('/:id/redirect-uris/:uriId', async (c) => {
  const res = await fetchWithAuth(
    c,
    SESSION_COOKIE,
    `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris/${c.req.param('uriId')}`,
    { method: 'DELETE' }
  );
  if (res.status === 204) return c.body(null, 204);
  return c.json(await res.json(), res.status as 200);
});

export default app;
