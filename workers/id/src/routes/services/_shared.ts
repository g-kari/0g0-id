import { z } from "zod";
import { createLogger } from "@0g0-id/shared";
import type { IdpEnv, TokenPayload } from "@0g0-id/shared";

export type Variables = { user: TokenPayload };
export type ServiceAppEnv = { Bindings: IdpEnv; Variables: Variables };

export const servicesLogger = createLogger("services");

// サポートされているスコープの一覧
const SUPPORTED_SCOPES = ["profile", "email", "phone", "address"] as const;

const ScopeEnum = z.enum(SUPPORTED_SCOPES);

export const CreateServiceSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  allowed_scopes: z.array(ScopeEnum).min(1, "allowed_scopes must not be empty").optional(),
});

export const PatchServiceSchema = z
  .object({
    name: z
      .string()
      .min(1, "name must not be empty")
      .max(100, "name must be 100 characters or less")
      .optional(),
    allowed_scopes: z.array(ScopeEnum).min(1, "allowed_scopes must not be empty").optional(),
  })
  .refine((data) => data.name !== undefined || data.allowed_scopes !== undefined, {
    message: "At least one of name or allowed_scopes must be provided",
  });

export const AddRedirectUriSchema = z
  .object({
    uri: z.string().min(1, "uri is required").max(2048, "URI must be 2048 characters or less"),
  })
  .refine(
    (data) => {
      try {
        const url = new URL(data.uri);
        const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        return isLocalhost || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Redirect URI must use HTTPS (HTTP is only allowed for localhost/127.0.0.1)" },
  );

export const TransferOwnerSchema = z.object({
  new_owner_user_id: z.string().min(1, "new_owner_user_id is required"),
});
