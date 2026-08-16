import { database } from "../database/connection.js";

export function assertLoginAllowed(scope: string, address: string, now = Date.now()) {
  const connection = database();
  connection.prepare("DELETE FROM auth_login_attempts WHERE resetAt <= ?").run(now);
  const row = connection
    .prepare("SELECT attemptCount, resetAt FROM auth_login_attempts WHERE scope = ? AND address = ?")
    .get(scope, address) as { attemptCount: number; resetAt: number } | undefined;
  return !row || row.resetAt <= now || row.attemptCount < 5;
}

export function recordLoginFailure(scope: string, address: string, resetAt: number) {
  database().prepare(`
    INSERT INTO auth_login_attempts (scope, address, attemptCount, resetAt, updatedAt)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(scope, address) DO UPDATE SET
      attemptCount = CASE WHEN auth_login_attempts.resetAt <= ? THEN 1 ELSE auth_login_attempts.attemptCount + 1 END,
      resetAt = CASE WHEN auth_login_attempts.resetAt <= ? THEN excluded.resetAt ELSE auth_login_attempts.resetAt END,
      updatedAt = excluded.updatedAt
  `).run(scope, address, resetAt, new Date().toISOString(), Date.now(), Date.now());
}

export function clearLoginFailures(scope: string, address: string) {
  database().prepare("DELETE FROM auth_login_attempts WHERE scope = ? AND address = ?").run(scope, address);
}
