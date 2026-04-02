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

export async function deleteExpiredDeviceCodes(db: D1Database): Promise<void> {
  await db
    .prepare(`DELETE FROM device_codes WHERE datetime(expires_at) < datetime('now')`)
    .run();
}
