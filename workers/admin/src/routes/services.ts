import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { BffEnv } from '@0g0-id/shared';
import { SESSION_COOKIE } from './auth';

const app = new Hono<{ Bindings: BffEnv }>();

function getSession(cookie: string | undefined): { access_token: string } | null {
  if (!cookie) return null;
  try {
    return JSON.parse(decodeURIComponent(atob(cookie)));
  } catch {
    return null;
  }
}

// GET /api/services
app.get('/', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/services`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  );
  return c.json(await res.json(), res.status as 200);
});

// POST /api/services
app.post('/', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/services`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  );
  return c.json(await res.json(), res.status as 200);
});

// DELETE /api/services/:id
app.delete('/:id', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  );
  if (res.status === 204) return c.body(null, 204);
  return c.json(await res.json(), res.status as 200);
});

// GET /api/services/:id/redirect-uris
app.get('/:id/redirect-uris', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  );
  return c.json(await res.json(), res.status as 200);
});

// POST /api/services/:id/redirect-uris
app.post('/:id/redirect-uris', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
  }

  const res = await c.env.IDP.fetch(
    new Request(`${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Origin: c.env.IDP_ORIGIN,
      },
      body: JSON.stringify(body),
    })
  );
  return c.json(await res.json(), res.status as 200);
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete('/:id/redirect-uris/:uriId', async (c) => {
  const session = getSession(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401);

  const res = await c.env.IDP.fetch(
    new Request(
      `${c.env.IDP_ORIGIN}/api/services/${c.req.param('id')}/redirect-uris/${c.req.param('uriId')}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }
    )
  );
  if (res.status === 204) return c.body(null, 204);
  return c.json(await res.json(), res.status as 200);
});

export default app;
