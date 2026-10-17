export interface AccountLockout {
  user_id: string;
  failed_attempts: number;
  locked_until: string | null;
  last_failed_at: string | null;
  updated_at: string;
}

export interface LockoutConfig {
  maxAttempts: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
}

const DEFAULT_CONFIG: LockoutConfig = {
  maxAttempts: 5,
  baseLockSeconds: 300,
  maxLockSeconds: 3600,
};

function calculateLockDuration(failedAttempts: number, config: LockoutConfig): number {
  const overThreshold = failedAttempts - config.maxAttempts;
  if (overThreshold <= 0) return 0;
  const duration = config.baseLockSeconds * Math.pow(2, overThreshold - 1);
  return Math.min(duration, config.maxLockSeconds);
}

export async function getAccountLockout(
  db: D1Database,
  userId: string,
): Promise<AccountLockout | null> {
  return db
    .prepare("SELECT * FROM account_lockouts WHERE user_id = ?")
    .bind(userId)
    .first<AccountLockout>();
}

export async function isAccountLocked(
  db: D1Database,
  userId: string,
): Promise<{ locked: boolean; lockedUntil: string | null; failedAttempts: number }> {
  const lockout = await getAccountLockout(db, userId);
  if (!lockout) return { locked: false, lockedUntil: null, failedAttempts: 0 };
  if (!lockout.locked_until)
    return { locked: false, lockedUntil: null, failedAttempts: lockout.failed_attempts };

  const now = new Date().toISOString();
  if (lockout.locked_until > now) {
    return {
      locked: true,
      lockedUntil: lockout.locked_until,
      failedAttempts: lockout.failed_attempts,
    };
  }

  return { locked: false, lockedUntil: null, failedAttempts: lockout.failed_attempts };
}

export async function recordFailedAttempt(
  db: D1Database,
  userId: string,
  config: LockoutConfig = DEFAULT_CONFIG,
): Promise<{ locked: boolean; lockedUntil: string | null; failedAttempts: number }> {
  const now = new Date();
  const nowIso = now.toISOString();

  const existing = await getAccountLockout(db, userId);
  const shouldDecay =
    existing?.last_failed_at &&
    now.getTime() - new Date(existing.last_failed_at).getTime() > config.maxLockSeconds * 1000;

  if (shouldDecay) {
    await db.prepare("DELETE FROM account_lockouts WHERE user_id = ?").bind(userId).run();
  }

  await db
    .prepare(
      `INSERT INTO account_lockouts (user_id, failed_attempts, locked_until, last_failed_at, updated_at)
       VALUES (?, 1, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         failed_attempts = failed_attempts + 1,
         last_failed_at = excluded.last_failed_at,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, nowIso, nowIso)
    .run();

  const updated = await getAccountLockout(db, userId);
  const failedAttempts = updated?.failed_attempts ?? 1;
  const lockDuration = calculateLockDuration(failedAttempts, config);
  const lockedUntil =
    lockDuration > 0 ? new Date(now.getTime() + lockDuration * 1000).toISOString() : null;

  if (lockedUntil) {
    await db
      .prepare("UPDATE account_lockouts SET locked_until = ? WHERE user_id = ?")
      .bind(lockedUntil, userId)
      .run();
  }

  return { locked: lockedUntil !== null, lockedUntil, failedAttempts };
}

export async function resetFailedAttempts(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM account_lockouts WHERE user_id = ?").bind(userId).run();
}

export const clearLockout = resetFailedAttempts;
