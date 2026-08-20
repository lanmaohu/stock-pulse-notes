import crypto from "node:crypto";
import type {
  Creator,
  CreatorCandidate,
  Platform,
  PlatformAccount,
  PlatformAccountStatus
} from "../../shared/types.js";
import { database } from "../database/connection.js";
import { optionalString, sqliteBoolean } from "../database/rows.js";

type PlatformAccountRow = Omit<PlatformAccount, "avatarUrl" | "lastCheckedAt" | "error"> & {
  avatarUrl: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  credentialsCiphertext: string;
};

type CreatorRow = Omit<Creator, "enabled" | "handle" | "avatarUrl" | "lastCollectedAt" | "lastCollectionStatus" | "lastError"> & {
  enabled: number;
  handle: string | null;
  avatarUrl: string | null;
  lastCollectedAt: string | null;
  lastCollectionStatus: "success" | "error" | null;
  lastError: string | null;
};

function toPlatformAccount(row: PlatformAccountRow): PlatformAccount {
  const { credentialsCiphertext: _credential, ...safe } = row;
  return {
    ...safe,
    avatarUrl: optionalString(row.avatarUrl),
    lastCheckedAt: optionalString(row.lastCheckedAt),
    error: optionalString(row.error)
  };
}

function toCreator(row: CreatorRow): Creator {
  return {
    ...row,
    enabled: sqliteBoolean(row.enabled),
    handle: optionalString(row.handle),
    avatarUrl: optionalString(row.avatarUrl),
    lastCollectedAt: optionalString(row.lastCollectedAt),
    lastCollectionStatus: row.lastCollectionStatus || undefined,
    lastError: optionalString(row.lastError)
  };
}

export function listPlatformAccounts(): PlatformAccount[] {
  const rows = database().prepare("SELECT * FROM platform_accounts ORDER BY platform ASC").all() as PlatformAccountRow[];
  return rows.map(toPlatformAccount);
}

export function getPlatformAccountWithCredential(platform: Platform) {
  const row = database().prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(platform) as PlatformAccountRow | undefined;
  return row ? { account: toPlatformAccount(row), encryptedCredential: row.credentialsCiphertext } : null;
}

export function upsertPlatformAccount(input: {
  platform: Platform;
  externalUserId: string;
  displayName: string;
  avatarUrl?: string;
  encryptedCredential: string;
}): PlatformAccount {
  const connection = database();
  const existing = connection.prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(input.platform) as PlatformAccountRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  connection.prepare(`
    INSERT INTO platform_accounts (
      id, platform, externalUserId, displayName, avatarUrl, status, credentialsCiphertext,
      lastCheckedAt, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      externalUserId = excluded.externalUserId,
      displayName = excluded.displayName,
      avatarUrl = excluded.avatarUrl,
      status = 'connected',
      credentialsCiphertext = excluded.credentialsCiphertext,
      lastCheckedAt = excluded.lastCheckedAt,
      error = NULL,
      updatedAt = excluded.updatedAt
  `).run(
    id, input.platform, input.externalUserId, input.displayName.slice(0, 120), input.avatarUrl || null,
    input.encryptedCredential, now, existing?.createdAt || now, now
  );
  return toPlatformAccount(connection.prepare("SELECT * FROM platform_accounts WHERE platform = ?").get(input.platform) as PlatformAccountRow);
}

export function updatePlatformAccountStatus(
  id: string,
  status: PlatformAccountStatus,
  input: { error?: string; displayName?: string; avatarUrl?: string } = {}
) {
  const connection = database();
  const current = connection.prepare("SELECT * FROM platform_accounts WHERE id = ?").get(id) as PlatformAccountRow | undefined;
  if (!current) return null;
  const now = new Date().toISOString();
  connection.prepare(`
    UPDATE platform_accounts
    SET status = ?, displayName = ?, avatarUrl = ?, lastCheckedAt = ?, error = ?, updatedAt = ?
    WHERE id = ?
  `).run(status, input.displayName || current.displayName, input.avatarUrl || current.avatarUrl, now, input.error || null, now, id);
  return toPlatformAccount(connection.prepare("SELECT * FROM platform_accounts WHERE id = ?").get(id) as PlatformAccountRow);
}

export function deletePlatformAccount(id: string) {
  return Number(database().prepare("DELETE FROM platform_accounts WHERE id = ?").run(id).changes) > 0;
}

export function replacePlatformAccountCredential(platform: Platform, encryptedCredential: string) {
  const result = database().prepare(`
    UPDATE platform_accounts
    SET credentialsCiphertext = ?, updatedAt = ?
    WHERE platform = ?
  `).run(encryptedCredential, new Date().toISOString(), platform);
  return Number(result.changes) > 0;
}

export function listCreators(options: { enabledOnly?: boolean; ids?: string[] } = {}): Creator[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (options.enabledOnly) clauses.push("enabled = 1");
  if (options.ids?.length) {
    clauses.push(`id IN (${options.ids.map(() => "?").join(",")})`);
    values.push(...options.ids);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database().prepare(`SELECT * FROM creators ${where} ORDER BY enabled DESC, name COLLATE NOCASE ASC`)
    .all(...values) as CreatorRow[];
  return rows.map(toCreator);
}

export function getCreator(id: string): Creator | null {
  const row = database().prepare("SELECT * FROM creators WHERE id = ?").get(id) as CreatorRow | undefined;
  return row ? toCreator(row) : null;
}

export function upsertCreator(candidate: CreatorCandidate): Creator {
  const connection = database();
  const existing = connection.prepare("SELECT * FROM creators WHERE platform = ? AND externalId = ?")
    .get(candidate.platform, candidate.externalId) as CreatorRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  connection.prepare(`
    INSERT INTO creators (
      id, platform, externalId, name, handle, avatarUrl, profileUrl, enabled, lastCollectedAt,
      lastCollectionStatus, lastError, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(platform, externalId) DO UPDATE SET
      name = excluded.name,
      handle = excluded.handle,
      avatarUrl = excluded.avatarUrl,
      profileUrl = excluded.profileUrl,
      enabled = 1,
      updatedAt = excluded.updatedAt
  `).run(
    id, candidate.platform, candidate.externalId, candidate.name.slice(0, 120), candidate.handle || null,
    candidate.avatarUrl || null, candidate.profileUrl, existing?.createdAt || now, now
  );
  return toCreator(connection.prepare("SELECT * FROM creators WHERE platform = ? AND externalId = ?")
    .get(candidate.platform, candidate.externalId) as CreatorRow);
}

export function setCreatorEnabled(id: string, enabled: boolean) {
  const result = database().prepare("UPDATE creators SET enabled = ?, updatedAt = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return Number(result.changes) > 0 ? getCreator(id) : null;
}

export function updateCreatorCollection(
  id: string,
  status: "success" | "error",
  input: { error?: string; name?: string; avatarUrl?: string } = {}
) {
  const connection = database();
  const current = connection.prepare("SELECT * FROM creators WHERE id = ?").get(id) as CreatorRow | undefined;
  if (!current) return null;
  const now = new Date().toISOString();
  connection.prepare(`
    UPDATE creators
    SET name = ?, avatarUrl = ?, lastCollectedAt = ?, lastCollectionStatus = ?, lastError = ?, updatedAt = ?
    WHERE id = ?
  `).run(input.name || current.name, input.avatarUrl || current.avatarUrl, now, status, input.error || null, now, id);
  return getCreator(id);
}
