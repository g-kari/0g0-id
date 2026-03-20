import { Hono } from 'hono';
import { z } from 'zod';
import {
  listServices,
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
} from '@0g0-id/shared';
import type { IdpEnv, TokenPayload } from '@0g0-id/shared';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { csrfMiddleware } from '../middleware/csrf';

type Variables = { user: TokenPayload };

// サポートされているスコープの一覧
const SUPPORTED_SCOPES = ['profile', 'email', 'phone', 'address'] as const;
type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

const CreateServiceSchema = z.object({
  name: z.string().min(1, 'name is required'),
  allowed_scopes: z.array(z.string()).optional(),
});

const PatchServiceSchema = z
  .object({
    name: z.string().min(1, 'name must not be empty').optional(),
    allowed_scopes: z
      .array(z.string(), { message: 'allowed_scopes must be an array' })
      .optional(),
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
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = CreateServiceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } }, 400);
  }
  const body = parsed.data;

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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = PatchServiceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } },
      400
    );
  }
  const { name, allowed_scopes } = parsed.data;

  // allowed_scopesが指定された場合はバリデーション
  if (allowed_scopes !== undefined) {
    const invalidScopes = allowed_scopes.filter(
      (s) => !SUPPORTED_SCOPES.includes(s as SupportedScope)
    );
    if (invalidScopes.length > 0) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: `Invalid scopes: ${invalidScopes.join(', ')}. Supported scopes: ${SUPPORTED_SCOPES.join(', ')}`,
          },
        },
        400
      );
    }
    if (allowed_scopes.length === 0) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'allowed_scopes must not be empty' } },
        400
      );
    }
  }

  const updated = await updateServiceFields(c.env.DB, serviceId, {
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(allowed_scopes !== undefined ? { allowedScopes: JSON.stringify(allowed_scopes) } : {}),
  });

  if (!updated) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Service not found' } }, 404);
  }

  return c.json({
    data: {
      id: updated!.id,
      name: updated!.name,
      client_id: updated!.client_id,
      allowed_scopes: updated!.allowed_scopes,
      owner_user_id: updated!.owner_user_id,
      updated_at: updated!.updated_at,
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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = AddRedirectUriSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } }, 400);
  }

  const normalized = normalizeRedirectUri(parsed.data.uri);
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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } }, 400);
  }

  const parsed = TransferOwnerSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid request' } },
      400
    );
  }
  const { new_owner_user_id } = parsed.data;

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
