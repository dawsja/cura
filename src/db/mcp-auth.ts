/**
 * Persistence for the MCP server's device-code OAuth flow. See
 * `src/lib/mcp-oauth.ts` for the protocol constants and secret helpers.
 *
 * Client-facing operations (create/exchange/refresh/revoke/authenticate)
 * are keyed by an unguessable secret's hash. User-facing operations
 * (decide, list, revoke) take `userId` and filter by `user_id`.
 */
import { and, eq, gt, isNotNull, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from './client';
import { mcpDeviceCodes, mcpGrants, mcpTokens } from './schema/mcp_auth';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  SLOW_DOWN_INCREMENT_SECONDS,
  generateAccessToken,
  generateDeviceCode,
  generateRefreshToken,
  generateUserCode,
  hashSecret,
} from '@/lib/mcp-oauth';
import { logger } from '@/lib/logger';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OAuthErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; error: OAuthErrorCode; description: string };

const LAST_USED_RESOLUTION_MS = 60_000;

function secondsFrom(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

// ---- Device authorization -------------------------------------------------

export async function createDeviceAuthorization(
  clientId: string,
  scope: string,
  now = new Date(),
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
  const deviceCode = generateDeviceCode();
  // User codes are random from a 2.56e10 space, so a collision with a live
  // code is vanishingly rare; retry a few times rather than fail.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = generateUserCode();
    try {
      await db.insert(mcpDeviceCodes).values({
        id: nanoid(),
        deviceCodeHash: hashSecret(deviceCode),
        userCode,
        clientId,
        scope,
        intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
        expiresAt: secondsFrom(now, DEVICE_CODE_TTL_SECONDS),
      });
      return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Expired-but-uncleaned rows can hold a code; free them for reuse.
      await db
        .delete(mcpDeviceCodes)
        .where(and(eq(mcpDeviceCodes.userCode, userCode), lt(mcpDeviceCodes.expiresAt, now)));
    }
  }
  throw new Error('could not allocate a unique device user code');
}

/** Details shown on the approval page for a still-pending request. */
export async function getPendingDeviceRequest(
  userCode: string,
  now = new Date(),
): Promise<{ clientId: string; scope: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ clientId: mcpDeviceCodes.clientId, scope: mcpDeviceCodes.scope, expiresAt: mcpDeviceCodes.expiresAt })
    .from(mcpDeviceCodes)
    .where(and(
      eq(mcpDeviceCodes.userCode, userCode),
      eq(mcpDeviceCodes.status, 'pending'),
      gt(mcpDeviceCodes.expiresAt, now),
    ))
    .limit(1);
  return row ?? null;
}

/** Approve or deny a pending request on behalf of `userId`. False if the code is unknown, expired, or decided. */
export async function decideDeviceRequest(
  userId: string,
  userCode: string,
  approve: boolean,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(mcpDeviceCodes)
    .set({ status: approve ? 'approved' : 'denied', userId, decidedAt: now })
    .where(and(
      eq(mcpDeviceCodes.userCode, userCode),
      eq(mcpDeviceCodes.status, 'pending'),
      gt(mcpDeviceCodes.expiresAt, now),
    ))
    .returning({ id: mcpDeviceCodes.id, clientId: mcpDeviceCodes.clientId });
  const row = rows[0];
  if (row) logger.info({ userId, deviceRequestId: row.id, clientId: row.clientId, approve }, 'mcp: device request decided');
  return Boolean(row);
}

// ---- Token issuance -------------------------------------------------------

async function issueTokens(tx: Tx, grantId: string, userId: string, scope: string, now: Date): Promise<TokenResponse> {
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  await tx.insert(mcpTokens).values([
    {
      id: nanoid(),
      grantId,
      userId,
      kind: 'access',
      tokenHash: hashSecret(accessToken),
      expiresAt: secondsFrom(now, ACCESS_TOKEN_TTL_SECONDS),
    },
    {
      id: nanoid(),
      grantId,
      userId,
      kind: 'refresh',
      tokenHash: hashSecret(refreshToken),
      expiresAt: secondsFrom(now, REFRESH_TOKEN_TTL_SECONDS),
    },
  ]);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

/** RFC 8628 §3.4/3.5 device access token request. */
export async function exchangeDeviceCode(deviceCode: string, clientId: string, now = new Date()): Promise<TokenResult> {
  return db.transaction(async (tx): Promise<TokenResult> => {
    const [row] = await tx
      .select()
      .from(mcpDeviceCodes)
      .where(eq(mcpDeviceCodes.deviceCodeHash, hashSecret(deviceCode)))
      .for('update')
      .limit(1);
    if (!row || row.clientId !== clientId || row.status === 'consumed') {
      return { ok: false, error: 'invalid_grant', description: 'unknown or already used device_code' };
    }
    if (row.expiresAt <= now) {
      return { ok: false, error: 'expired_token', description: 'the device_code has expired' };
    }
    if (row.status === 'denied') {
      return { ok: false, error: 'access_denied', description: 'the user denied the request' };
    }
    if (row.status === 'pending') {
      const tooFast = row.lastPolledAt !== null
        && now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000;
      await tx
        .update(mcpDeviceCodes)
        .set({
          lastPolledAt: now,
          intervalSeconds: tooFast ? row.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS : row.intervalSeconds,
        })
        .where(eq(mcpDeviceCodes.id, row.id));
      return tooFast
        ? { ok: false, error: 'slow_down', description: `poll no faster than every ${row.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS}s` }
        : { ok: false, error: 'authorization_pending', description: 'waiting for the user to approve' };
    }

    // Approved: turn the request into a grant exactly once.
    if (!row.userId) return { ok: false, error: 'invalid_grant', description: 'device_code has no approving user' };
    const grantId = nanoid();
    await tx.insert(mcpGrants).values({
      id: grantId,
      userId: row.userId,
      clientId: row.clientId,
      scope: row.scope,
      lastUsedAt: now,
    });
    await tx.update(mcpDeviceCodes).set({ status: 'consumed' }).where(eq(mcpDeviceCodes.id, row.id));
    const tokens = await issueTokens(tx, grantId, row.userId, row.scope, now);
    logger.info({ userId: row.userId, grantId, clientId: row.clientId }, 'mcp: grant created');
    return { ok: true, tokens };
  });
}

async function revokeGrantInTx(tx: Tx, grantId: string, now: Date): Promise<void> {
  await tx.update(mcpGrants).set({ revokedAt: now }).where(and(eq(mcpGrants.id, grantId), isNull(mcpGrants.revokedAt)));
  await tx.update(mcpTokens).set({ revokedAt: now }).where(and(eq(mcpTokens.grantId, grantId), isNull(mcpTokens.revokedAt)));
}

/** RFC 6749 §6 refresh with rotation and reuse detection. */
export async function refreshTokens(refreshToken: string, clientId: string, now = new Date()): Promise<TokenResult> {
  const invalid: TokenResult = { ok: false, error: 'invalid_grant', description: 'invalid refresh_token' };
  const result = await db.transaction(async (tx): Promise<TokenResult | { reused: string }> => {
    const [row] = await tx
      .select({ token: mcpTokens, grant: mcpGrants })
      .from(mcpTokens)
      .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
      .where(and(eq(mcpTokens.tokenHash, hashSecret(refreshToken)), eq(mcpTokens.kind, 'refresh')))
      .for('update')
      .limit(1);
    if (!row || row.grant.clientId !== clientId) return invalid;
    if (row.grant.revokedAt || row.token.revokedAt) return invalid;
    if (row.token.rotatedAt) {
      // A refresh token was replayed after rotation: either the client is
      // broken or the token leaked. Kill the whole grant (RFC 9700 §4.14.2).
      await revokeGrantInTx(tx, row.grant.id, now);
      return { reused: row.grant.id };
    }
    if (row.token.expiresAt <= now) return invalid;

    await tx.update(mcpTokens).set({ rotatedAt: now }).where(eq(mcpTokens.id, row.token.id));
    await tx.update(mcpGrants).set({ lastUsedAt: now }).where(eq(mcpGrants.id, row.grant.id));
    const tokens = await issueTokens(tx, row.grant.id, row.grant.userId, row.grant.scope, now);
    return { ok: true, tokens };
  });
  if ('reused' in result) {
    logger.warn({ grantId: result.reused }, 'mcp: refresh token reuse detected; grant revoked');
    return invalid;
  }
  return result;
}

/**
 * RFC 7009 revocation. Revoking a refresh token ends the whole grant;
 * revoking an access token only invalidates that token.
 */
export async function revokeToken(token: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: mcpTokens.id, kind: mcpTokens.kind, grantId: mcpTokens.grantId })
      .from(mcpTokens)
      .where(eq(mcpTokens.tokenHash, hashSecret(token)))
      .limit(1);
    if (!row) return;
    if (row.kind === 'refresh') {
      await revokeGrantInTx(tx, row.grantId, now);
    } else {
      await tx.update(mcpTokens).set({ revokedAt: now }).where(and(eq(mcpTokens.id, row.id), isNull(mcpTokens.revokedAt)));
    }
  });
}

export interface McpPrincipal {
  userId: string;
  grantId: string;
  clientId: string;
  scope: string;
}

/** Resolve a bearer access token to its user, or null if invalid/expired/revoked. */
export async function authenticateAccessToken(token: string, now = new Date()): Promise<McpPrincipal | null> {
  const [row] = await db
    .select({
      userId: mcpGrants.userId,
      grantId: mcpGrants.id,
      clientId: mcpGrants.clientId,
      scope: mcpGrants.scope,
      lastUsedAt: mcpGrants.lastUsedAt,
    })
    .from(mcpTokens)
    .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
    .where(and(
      eq(mcpTokens.tokenHash, hashSecret(token)),
      eq(mcpTokens.kind, 'access'),
      isNull(mcpTokens.revokedAt),
      gt(mcpTokens.expiresAt, now),
      isNull(mcpGrants.revokedAt),
    ))
    .limit(1);
  if (!row) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.update(mcpGrants).set({ lastUsedAt: now }).where(eq(mcpGrants.id, row.grantId));
  }
  return { userId: row.userId, grantId: row.grantId, clientId: row.clientId, scope: row.scope };
}

// ---- Connected-app management (user scoped) --------------------------------

export interface McpGrantSummary {
  id: string;
  clientId: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listMcpGrants(userId: string): Promise<McpGrantSummary[]> {
  const rows = await db
    .select({
      id: mcpGrants.id,
      clientId: mcpGrants.clientId,
      scope: mcpGrants.scope,
      createdAt: mcpGrants.createdAt,
      lastUsedAt: mcpGrants.lastUsedAt,
    })
    .from(mcpGrants)
    .where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)))
    .orderBy(sql`${mcpGrants.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    scope: r.scope,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeMcpGrant(userId: string, grantId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(mcpGrants)
      .set({ revokedAt: now })
      .where(and(eq(mcpGrants.id, grantId), eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt)))
      .returning({ id: mcpGrants.id });
    if (rows.length === 0) return false;
    await tx
      .update(mcpTokens)
      .set({ revokedAt: now })
      .where(and(eq(mcpTokens.grantId, grantId), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
    logger.info({ userId, grantId }, 'mcp: grant revoked by user');
    return true;
  });
}

// ---- Cleanup ----------------------------------------------------------------

export interface McpAuthCleanupReport {
  deviceCodesDeleted: number;
  grantsDeleted: number;
  tokensDeleted: number;
}

/**
 * Delete stale device requests, revoked grants, grants with no usable
 * tokens left (the client stopped refreshing), and expired or revoked
 * tokens. A one-day grace keeps recently expired rows around so clients
 * still get precise error codes.
 */
export async function cleanupMcpAuth(now = new Date()): Promise<McpAuthCleanupReport> {
  const graceCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return db.transaction(async (tx) => {
    const deviceCodes = await tx
      .delete(mcpDeviceCodes)
      .where(lt(mcpDeviceCodes.expiresAt, graceCutoff))
      .returning({ id: mcpDeviceCodes.id });
    const grants = await tx
      .delete(mcpGrants)
      .where(or(
        and(isNotNull(mcpGrants.revokedAt), lt(mcpGrants.revokedAt, graceCutoff)),
        and(
          lt(mcpGrants.createdAt, graceCutoff),
          notExists(
            tx.select({ one: sql`1` })
              .from(mcpTokens)
              .where(and(eq(mcpTokens.grantId, mcpGrants.id), gt(mcpTokens.expiresAt, graceCutoff))),
          ),
        ),
      ))
      .returning({ id: mcpGrants.id });
    const tokens = await tx
      .delete(mcpTokens)
      .where(or(
        lt(mcpTokens.expiresAt, graceCutoff),
        and(isNotNull(mcpTokens.revokedAt), lt(mcpTokens.revokedAt, graceCutoff)),
      ))
      .returning({ id: mcpTokens.id });
    return { deviceCodesDeleted: deviceCodes.length, grantsDeleted: grants.length, tokensDeleted: tokens.length };
  });
}
