import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "@0g0-id/shared";
import type { IdpEnv, TokenPayload, User, MyProfile, AdminUserSummary } from "@0g0-id/shared";
import {
  countServicesByOwner,
  findUserById,
  revokeUserTokens,
  deleteMcpSessionsByUser,
  deleteUser,
  restErrorBody,
} from "@0g0-id/shared";

export const PatchMeSchema = z
  .object({
    name: z
      .string()
      .min(1, "name must not be empty")
      .max(100, "name must be 100 characters or less")
      .optional(),
    picture: z
      .string()
      .url("picture must be a valid URL")
      .startsWith("https://", "picture must use HTTPS")
      .max(2048, "picture URL must be 2048 characters or less")
      .nullable()
      .optional(),
    phone: z.string().max(50, "phone must be 50 characters or less").nullable().optional(),
    address: z.string().max(500, "address must be 500 characters or less").nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.picture !== undefined ||
      data.phone !== undefined ||
      data.address !== undefined,
    { message: "At least one field must be provided" },
  );

export const PatchRoleSchema = z.object({
  role: z.enum(["user", "admin"], { message: 'role must be "user" or "admin"' }),
});

export const RevokeOthersSchema = z.object({
  token_hash: z.string().min(1, "token_hash is required"),
});

export type Variables = { user: TokenPayload; dbUser: User };

export type UsersApp = Hono<{ Bindings: IdpEnv; Variables: Variables }>;

export const usersLogger = createLogger("users");

export function formatMyProfile(user: User): MyProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    phone: user.phone,
    address: user.address,
    role: user.role,
  };
}

export function formatAdminUserDetail(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    phone: user.phone,
    address: user.address,
    role: user.role,
    banned_at: user.banned_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function formatAdminUserSummary(user: User): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    banned_at: user.banned_at,
    created_at: user.created_at,
  };
}

/**
 * ユーザーIDでユーザーを検索し、存在しない場合は404エラーレスポンスを返す。
 * 存在する場合はUserオブジェクトを返す。
 */
export async function requireTargetUser(
  db: D1Database,
  targetId: string,
): Promise<User | Response> {
  const user = await findUserById(db, targetId);
  if (!user) {
    return new Response(JSON.stringify(restErrorBody("NOT_FOUND", "User not found")), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return user;
}

export async function performUserDeletion(
  db: D1Database,
  userId: string,
): Promise<{ code: string; message: string } | null> {
  const ownedServices = await countServicesByOwner(db, userId);
  if (ownedServices > 0) {
    return {
      code: "CONFLICT",
      message: `User owns ${ownedServices} service(s). Transfer ownership before deleting.`,
    };
  }
  await revokeUserTokens(db, userId, "admin_action");
  await deleteMcpSessionsByUser(db, userId);
  await deleteUser(db, userId);
  return null;
}
