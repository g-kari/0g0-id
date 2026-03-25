import { Hono } from 'hono';
import { z } from 'zod';
import {
  listServices,
  countServices,
  findServiceById,
  createService,
  updateServiceFields,
  deleteService,
  listRedirectUris,
  addRedirectUri,
  deleteRedirectUri,
  generateClientId,
  generateClientSecret,
  sha256,
  normalizeRedirectUri,
  rotateClientSecret,
  transferServiceOwnership,
  findUserById,
  listUsersAuthorizedForService,
  countUsersAuthorizedForService,
  revokeUserServiceTokens,
  parsePagination,
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';
import { parseJsonBody } from '../utils/parse-body';

type Variables = { user: TokenPayload };

// サポートされているスコープの一覧
const SUPPORTED_SCOPES = ['profile', 'email', 'phone', 'address'] as const;

const ScopeEnum = z.enum(SUPPORTED_SCOPES);

const CreateServiceSchema = z.object({
  name: z.string().min(1, 'name is required').max(100, 'name must be 100 characters or less'),
  allowed_scopes: z.array(ScopeEnum).min(1, 'allowed_scopes must not be empty').optional(),
});

const PatchServiceSchema = z
  .object({
    name: z.string().min(1, 'name must not be empty').max(100, 'name must be 100 characters or less').optional(),
    allowed_scopes: z.array(ScopeEnum).min(1, 'allowed_scopes must not be empty').optional(),
  })
  .refine((data) => data.name !== undefined || data.allowed_scopes !== undefined, {
    message: 'At least one of name or allowed_scopes must be provided',
  });

const AddRedirectUriSchema = z.object({
  uri: z.string().min(1, 'uri is required'),
});

const TransferOwnerSchema = z.object({
  new_owner_user_id: z.string().min(1, 'new_owner_user_id is required'),
});

const app = new Hono<{ Bindings: IdpEnv; Variables: Variables }>();

// GET /api/services
app.get('/', authMiddleware, adminMiddleware, async (c) => {
  const limitStr = c.req.query('limit') ?? '50';
  const offsetStr = c.req.query('offset') ?? '0';
  const name = c.req.query('name');

  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(offsetStr, 10) || 0, 0);

  const [services, total] = await Promise.all([
    listServices(c.env.DB, { name, limit, offset }),
    countServices(c.env.DB, { name }),
  ]);

  return c.json({
    data: services.map((s) => ({
      id: s.id,
      name: s.name,
      client_id: s.client_id,
      allowed_scopes: s.allowed_scopes,
      owner_user_id: s.owner_user_id,
      created_at: s.created_at,
    })),
    total,
    limit,
    offset,
  });
});

// GET /api/services/:id
app.get('/:id', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  return c.json({
    data: {
      id: service.id,
      name: service.name,
      client_id: service.client_id,
      allowed_scopes: service.allowed_scopes,
      owner_user_id: service.owner_user_id,
      created_at: service.created_at,
      updated_at: service.updated_at,
    },
  });
});

// POST /api/services
app.post('/', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const result = await parseJsonBody(c, CreateServiceSchema);
  if (!result.ok) return result.response;
  const body = result.data;

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

// PATCH /api/services/:id — name または allowed_scopesの更新
app.patch('/:id', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param('id');

  const result = await parseJsonBody(c, PatchServiceSchema);
  if (!result.ok) return result.response;
  const { name, allowed_scopes } = result.data;

  const updated = await updateServiceFields(c.env.DB, serviceId, {
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(allowed_scopes !== undefined ? { allowedScopes: JSON.stringify(allowed_scopes) } : {}),
  });

  if (!updated) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  return c.json({
    data: {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      allowed_scopes: updated.allowed_scopes,
      owner_user_id: updated.owner_user_id,
      updated_at: updated.updated_at,
    },
  });
});

// DELETE /api/services/:id
app.delete('/:id', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
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
app.post('/:id/redirect-uris', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const result = await parseJsonBody(c, AddRedirectUriSchema);
  if (!result.ok) return result.response;

  const normalized = normalizeRedirectUri(result.data.uri);
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
  } catch (err) {
    console.error('[services] Failed to add redirect URI (possibly duplicate):', err);
    return c.json({ error: { code: 'CONFLICT', message: 'Redirect URI already exists' } }, 409);
  }
});

// POST /api/services/:id/rotate-secret — client_secretの再発行
app.post('/:id/rotate-secret', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const newClientSecret = generateClientSecret();
  const newClientSecretHash = await sha256(newClientSecret);

  const updated = await rotateClientSecret(c.env.DB, serviceId, newClientSecretHash);
  if (!updated) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  return c.json({
    data: {
      id: updated.id,
      client_id: updated.client_id,
      client_secret: newClientSecret,
      updated_at: updated.updated_at,
    },
  });
});

// PATCH /api/services/:id/owner — サービス所有権の転送
app.patch('/:id/owner', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param('id');

  const result = await parseJsonBody(c, TransferOwnerSchema);
  if (!result.ok) return result.response;
  const { new_owner_user_id } = result.data;

  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const newOwner = await findUserById(c.env.DB, new_owner_user_id);
  if (!newOwner) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'New owner user not found' } }, 404);
  }

  const updated = await transferServiceOwnership(c.env.DB, serviceId, new_owner_user_id);
  if (!updated) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  return c.json({
    data: {
      id: updated.id,
      name: updated.name,
      client_id: updated.client_id,
      owner_user_id: updated.owner_user_id,
      updated_at: updated.updated_at,
    },
  });
});

// GET /api/services/:id/users — サービスを認可済みのユーザー一覧（管理者のみ）
app.get('/:id/users', authMiddleware, adminMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const pagination = parsePagination(
    { limit: c.req.query('limit'), offset: c.req.query('offset') },
    { defaultLimit: 50, maxLimit: 100 }
  );
  if ('error' in pagination) {
    return c.json({ error: { code: 'BAD_REQUEST', message: pagination.error } }, 400);
  }
  const { limit, offset } = pagination;

  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const [users, total] = await Promise.all([
    listUsersAuthorizedForService(c.env.DB, serviceId, limit, offset),
    countUsersAuthorizedForService(c.env.DB, serviceId),
  ]);

  return c.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      role: u.role,
      created_at: u.created_at,
    })),
    total,
  });
});

// DELETE /api/services/:id/users/:userId — ユーザーのサービスアクセスを失効
app.delete('/:id/users/:userId', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
  const serviceId = c.req.param('id');
  const userId = c.req.param('userId');

  const service = await findServiceById(c.env.DB, serviceId);
  if (!service) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  const user = await findUserById(c.env.DB, userId);
  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const revokedCount = await revokeUserServiceTokens(c.env.DB, userId, serviceId);
  if (revokedCount === 0) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'User has no active authorization for this service' } },
      404
    );
  }

  return c.body(null, 204);
});

// DELETE /api/services/:id/redirect-uris/:uriId
app.delete('/:id/redirect-uris/:uriId', authMiddleware, adminMiddleware, csrfMiddleware, async (c) => {
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
