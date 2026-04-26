import type { Context, Env } from "hono";
import { restErrorBody } from "@0g0-id/shared";

type RequiredParamCheck = {
  value: string | undefined | null;
  message: string;
};

type LengthCheck = {
  value: string | undefined | null;
  max: number;
  message: string;
};

/**
 * 必須パラメータをまとめて検証し、不足があれば BAD_REQUEST を返す。
 * すべて通過すれば null を返す。
 */
export function validateRequiredParams<E extends Env>(
  c: Context<E>,
  checks: RequiredParamCheck[],
): Response | null {
  for (const check of checks) {
    if (!check.value) {
      return c.json(restErrorBody("BAD_REQUEST", check.message), 400);
    }
  }
  return null;
}

/**
 * パラメータの長さ上限をまとめて検証し、超過があれば BAD_REQUEST を返す。
 * undefined/null は検査をスキップする。すべて通過すれば null を返す。
 */
export function validateParamLengths<E extends Env>(
  c: Context<E>,
  checks: LengthCheck[],
): Response | null {
  for (const check of checks) {
    if (check.value != null && check.value.length > check.max) {
      return c.json(restErrorBody("BAD_REQUEST", check.message), 400);
    }
  }
  return null;
}
