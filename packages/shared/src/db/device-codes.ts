export interface DeviceCode {
  id: string;
  device_code_hash: string;
  user_code: string;
  service_id: string;
  scope: string | null;
  expires_at: string;
  user_id: string | null;
  approved_at: string | null;
  denied_at: string | null;
  last_polled_at: string | null;
  created_at: string;
}

export async function createDeviceCode(
  db: D1Database,
  opts: {
    id: string;
    deviceCodeHash: string;
    userCode: string;
    serviceId: string;
    scope: string | null;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_codes (id, device_code_hash, user_code, service_id, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(opts.id, opts.deviceCodeHash, opts.userCode, opts.serviceId, opts.scope, opts.expiresAt)
    .run();
}

export async function findDeviceCodeByUserCode(
  db: D1Database,
  userCode: string
): Promise<DeviceCode | null> {
  return db
    .prepare(`SELECT * FROM device_codes WHERE user_code = ?`)
    .bind(userCode)
    .first<DeviceCode>();
}

export async function findDeviceCodeByHash(
  db: D1Database,
  deviceCodeHash: string
): Promise<DeviceCode | null> {
  return db
    .prepare(`SELECT * FROM device_codes WHERE device_code_hash = ?`)
    .bind(deviceCodeHash)
    .first<DeviceCode>();
}

export async function approveDeviceCode(
  db: D1Database,
  id: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE device_codes SET user_id = ?, approved_at = datetime('now') WHERE id = ?`
    )
    .bind(userId, id)
    .run();
}

export async function denyDeviceCode(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE device_codes SET denied_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

/**
 * ポーリング間隔チェック＋更新をアトミックに行う。
 * 間隔内の再ポーリングの場合は false を返す（slow_down 応答用）。
 */
export async function tryUpdateDeviceCodePolledAt(
  db: D1Database,
  id: string,
  intervalSec: number
): Promise<boolean> {
  const now = new Date();
  const threshold = new Date(now.getTime() - intervalSec * 1000).toISOString();
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE device_codes
       SET last_polled_at = ?
       WHERE id = ?
         AND (last_polled_at IS NULL OR last_polled_at < ?)`
    )
    .bind(nowIso, id, threshold)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** @deprecated tryUpdateDeviceCodePolledAt を使用してください */
export async function updateDeviceCodePolledAt(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(`UPDATE device_codes SET last_polled_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

export async function deleteDeviceCode(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM device_codes WHERE id = ?`).bind(id).run();
}

/**
 * 承認済みデバイスコードをアトミックに削除する。
 * 他リクエストが先に削除済みの場合は false を返す（二重トークン発行防止）。
 */
export async function deleteApprovedDeviceCode(
  db: D1Database,
  id: string
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM device_codes WHERE id = ? AND approved_at IS NOT NULL`)
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteExpiredDeviceCodes(db: D1Database): Promise<void> {
  await db
    .prepare(`DELETE FROM device_codes WHERE datetime(expires_at) < datetime('now')`)
    .run();
}
