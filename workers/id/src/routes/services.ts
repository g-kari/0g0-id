import { Hono } from 'hono';
import {
  listServices,
  findServiceById,
  createService,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';

type Variables = { user: TokenPayload };

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/services
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const services = await listServices(c.env.DB);
  return c.json({
    data: services.map((s) => ({
      id: s.id,
      name: s.name,
      client_id: s.client_id,
      allowed_scopes: s.allowed_scopes,
      owner_user_id: s.owner_user_id,
      created_at: s.created_at,
    })),
  });
});

// POST /api/services
app.post('/', authMiddleware, adminMiddleware, async (c) => {
  let body: { name?: string; allowed_scopes?: string[] };
  try {
    body = await c.req.json<{ name?: string; allowed_scopes?: string[] }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
  }

  const tokenUser = c.get('user');
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = await sha256(clientSecret);
  const allowedScopes = JSON.stringify(body.allowed_scopes ?? ['profile', 'email']);

  const service = await createService(c.env.DB, {
    id: crypto.randomUUID(),
    name: body.name.trim(),
    clientId,
    clientSecretHash,
    allowedScopes,
    ownerUserId: tokenUser.sub,
  });

  // client_secretは作成時のみ返却
  return c.json(
    {
      data: {
        id: service.id,
        name: service.name,
        client_id: service.client_id,
        client_secret: clientSecret,
        allowed_scopes: service.allowed_scopes,
        created_at: service.created_at,
      },
    },
    201
  );
});

// DELETE /api/services/:id
app.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  await deleteService(c.env.DB, serviceId);
  return c.body(null, 204);
});

// GET /api/services/:id/redirect-uris
app.get('/:id/redirect-uris', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const uris = await listRedirectUris(c.env.DB, serviceId);
  return c.json({ data: uris });
});

// POST /api/services/:id/redirect-uris
app.post('/:id/redirect-uris', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  let body: { uri?: string };
  try {
    body = await c.req.json<{ uri?: string }>();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  if (!body.uri) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'uri is required' } }, 400);
  }

  const normalized = normalizeRedirectUri(body.uri);
  if (!normalized) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid redirect URI' } }, 400);
  }

  try {
    const uri = await addRedirectUri(c.env.DB, {
      id: crypto.randomUUID(),
      serviceId,
      uri: normalized,
    });
    return c.json({ data: uri }, 201);
  } catch {
    return c.json({ error: { code: 'CONFLICT', message: 'Redirect URI already exists' } }, 409);
  }
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete('/:id/redirect-uris/:uriId', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const uriId = c.req.param('uriId');

  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  await deleteRedirectUri(c.env.DB, uriId, serviceId);
  return c.body(null, 204);
});

export default app;
