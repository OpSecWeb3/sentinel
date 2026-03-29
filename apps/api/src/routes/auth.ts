import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@sentinel/db';
import { users, organizations, orgMemberships, apiKeys } from '@sentinel/db/schema/core';
import { eq, or, and, sql } from '@sentinel/db';
import { getCookie } from 'hono/cookie';
import { generateApiKey, generateInviteSecret, hashInviteSecret, decrypt } from '@sentinel/shared/crypto';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { createSession, destroySession, deleteSessionsByUserId, deleteSessionsByOrgId, deleteSessionsByUserIdExcept } from '../middleware/session.js';
import { requireAuth, requireOrg, requireRole } from '../middleware/rbac.js';
import { requireScope } from '../middleware/scope.js';
import { authLimiter, apiReadLimiter, apiWriteLimiter } from '../middleware/rate-limit.js';
import { generateNotifyKey } from '../middleware/notify-key.js';

const SALT_ROUNDS = 12;

// Lockout policy constants for brute-force protection on the login endpoint.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Detect Postgres unique-constraint violation (error code 23505).
 * Drizzle surfaces the underlying pg error object with a `code` property.
 */
function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code: string }).code === '23505';
  }
  return false;
}

// Lazily computed dummy hash for constant-time login responses when user is not found.
// This prevents timing-based user enumeration (bcrypt compare takes ~200ms).
// Using lazy init avoids blocking the event loop during module import.
let _dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!_dummyHash) {
    _dummyHash = await bcrypt.hash('dummy-password-for-timing', SALT_ROUNDS);
  }
  return _dummyHash;
}

const auth = new Hono<AppEnv>();

// Apply rate limiting: read limiter for GET requests, write limiter for mutating methods.
auth.use('*', async (c, next) => {
  if (c.req.method === 'GET') return apiReadLimiter(c, next);
  return apiWriteLimiter(c, next);
});

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  orgName: z.string().min(2).max(100).optional(),
  inviteSecret: z.string().optional(),
});

auth.post('/register', authLimiter, async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;
  const db = getDb();
  const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);

  // Check if user already exists
  const [existing] = await db.select({ id: users.id })
    .from(users)
    .where(or(eq(users.username, body.username), eq(users.email, body.email)))
    .limit(1);

  if (existing) {
    return c.json({ error: 'Registration failed' }, 409);
  }

  // First user bootstraps the system
  const [anyOrg] = await db.select({ id: organizations.id }).from(organizations).limit(1);

  if (!anyOrg) {
    if (!body.orgName) {
      return c.json({ error: 'orgName required for first user (creates the organization)' }, 400);
    }

    const slug = body.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (!slug) return c.json({ error: 'Invalid organisation name' }, 400);

    const { raw: invSecretRaw, hash: invSecretHash, encrypted: invSecretEncrypted } = generateInviteSecret();

    // Transaction: create user + org + membership atomically.
    // The try/catch handles the race where two concurrent requests both pass the
    // optimistic SELECT check above but one loses the INSERT due to the DB-level
    // UNIQUE constraint on users.username / users.email / organizations.slug.
    let result: { user: { id: string; username: string }; org: { id: string; name: string; slug: string } };
    try {
      result = await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({
          username: body.username, email: body.email, passwordHash,
        }).returning();

        const [org] = await tx.insert(organizations).values({
          name: body.orgName!, slug, inviteSecretHash: invSecretHash, inviteSecretEncrypted: invSecretEncrypted,
        }).returning();

        await tx.insert(orgMemberships).values({
          orgId: org.id, userId: user.id, role: 'admin',
        });

        return { user, org };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'Registration failed' }, 409);
      }
      throw err;
    }

    await createSession(c, { id: result.user.id, orgId: result.org.id, role: 'admin' });

    return c.json({
      user: { id: result.user.id, username: result.user.username },
      org: { id: result.org.id, name: result.org.name, slug: result.org.slug },
      // Raw secret shown once at org creation; only the hash is stored.
      inviteSecret: invSecretRaw,
    }, 201);
  }

  // Join existing org via invite secret
  if (!body.inviteSecret) {
    return c.json({ error: 'inviteSecret required to join an existing organization' }, 400);
  }

  const submittedHash = hashInviteSecret(body.inviteSecret);
  const [org] = await db.select()
    .from(organizations)
    .where(eq(organizations.inviteSecretHash, submittedHash))
    .limit(1);

  if (!org) return c.json({ error: 'Invalid invite secret' }, 403);

  // Catch unique-violation from the race where two concurrent requests both pass
  // the optimistic existence check but collide on the DB UNIQUE constraint.
  let result: { user: { id: string; username: string } };
  try {
    result = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        username: body.username, email: body.email, passwordHash,
      }).returning();

      await tx.insert(orgMemberships).values({
        orgId: org.id, userId: user.id, role: 'viewer',
      });

      return { user };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'Registration failed' }, 409);
    }
    throw err;
  }

  await createSession(c, { id: result.user.id, orgId: org.id, role: 'viewer' });

  return c.json({
    user: { id: result.user.id, username: result.user.username },
    org: { id: org.id, name: org.name, slug: org.slug },
  }, 201);
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

auth.post('/login', authLimiter, async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
  const { username, password } = parsed.data;
  const db = getDb();

  const [user] = await db.select()
    .from(users)
    .where(or(eq(users.username, username), eq(users.email, username)))
    .limit(1);

  if (!user) {
    // Perform a dummy bcrypt compare to equalize response timing and prevent
    // user-existence enumeration via timing side-channel.
    await bcrypt.compare(password, await getDummyHash());
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  // Check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return c.json({ error: 'Account temporarily locked. Try again later.' }, 423);
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    // Increment failed attempts and potentially lock
    const newAttempts = (user.failedLoginAttempts ?? 0) + 1;
    await db.update(users)
      .set({
        failedLoginAttempts: newAttempts,
        lockedUntil: newAttempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
          : null,
      })
      .where(eq(users.id, user.id));
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  // Reset failed attempts on successful login
  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await db.update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
  }

  const [membership] = await db.select()
    .from(orgMemberships)
    .where(eq(orgMemberships.userId, user.id))
    .limit(1);

  // Destroy any pre-existing session to prevent session fixation attacks.
  await destroySession(c);

  if (!membership) {
    // User exists but has no org membership.  Create an org-less session so
    // the frontend can redirect to /join-org after calling /auth/me.
    // IMPORTANT: we must NOT return a distinguishable error here — doing so
    // would let an unauthenticated attacker confirm that an account exists.
    await createSession(c, { id: user.id });
    return c.json({ status: 'ok', user: { id: user.id, username: user.username, role: null } });
  }

  await createSession(c, {
    id: user.id,
    orgId: membership.orgId,
    role: membership.role,
  });

  return c.json({ status: 'ok', user: { id: user.id, username: user.username, role: membership.role } });
});

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

auth.get('/me', requireAuth, (c) => {
  if (c.get('apiKeyId')) {
    return c.json({ apiKey: { keyId: c.get('apiKeyId'), scopes: c.get('scopes') } });
  }
  return c.json({
    user: { userId: c.get('userId'), orgId: c.get('orgId'), role: c.get('role') },
    needsOrg: !c.get('orgId'),
  });
});

// ---------------------------------------------------------------------------
// API Key management
// ---------------------------------------------------------------------------

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['api:read', 'api:write'])).default(['api:read']),
  expiresInDays: z.number().int().positive().optional(),
});

auth.post('/api-keys', requireAuth, requireOrg, requireScope('api:write'), async (c) => {
  const parsed = createKeySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);

  const { name, scopes, expiresInDays } = parsed.data;
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  const db = getDb();

  const { raw, prefix, hash } = generateApiKey('sk_');
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : undefined;

  const [key] = await db.insert(apiKeys).values({
    orgId, userId, name, keyHash: hash, keyPrefix: prefix, scopes, expiresAt,
  }).returning();

  return c.json({
    id: key.id, name: key.name, prefix: key.keyPrefix, scopes: key.scopes,
    expiresAt: key.expiresAt, createdAt: key.createdAt,
    key: raw,
    warning: 'Save this key now. It cannot be retrieved again.',
  }, 201);
});

auth.get('/api-keys', requireAuth, requireOrg, requireScope('api:read'), async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const keys = await db.select({
    id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix,
    scopes: apiKeys.scopes, lastUsedAt: apiKeys.lastUsedAt,
    expiresAt: apiKeys.expiresAt, revoked: apiKeys.revoked, createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.orgId, orgId));

  return c.json(keys);
});

auth.delete('/api-keys/:id', requireAuth, requireOrg, requireScope('api:write'), async (c) => {
  const orgId = c.get('orgId')!;
  const userId = c.get('userId')!;
  const keyId = c.req.param('id')!;
  const db = getDb();

  const [revoked] = await db.update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), eq(apiKeys.userId, userId)))
    .returning({ name: apiKeys.name });

  if (!revoked) return c.json({ error: 'API key not found' }, 404);
  return c.json({ status: 'revoked', name: revoked.name });
});

// ---------------------------------------------------------------------------
// Org invite secret management (admin only)
// ---------------------------------------------------------------------------

auth.get('/org/invite-secret', requireScope('api:read'), requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();
  const [org] = await db
    .select({ inviteSecretEncrypted: organizations.inviteSecretEncrypted })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return c.json({ error: 'Organisation not found' }, 404);
  if (!org.inviteSecretEncrypted) {
    // Orgs migrated from the pre-encryption schema need one regeneration.
    return c.json({ error: 'Invite secret not set. Call POST /auth/org/invite-secret/regenerate to generate one.' }, 404);
  }
  return c.json({ inviteSecret: decrypt(org.inviteSecretEncrypted) });
});

auth.post('/org/invite-secret/regenerate', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();
  const { raw, hash, encrypted } = generateInviteSecret();

  const [result] = await db.update(organizations)
    .set({ inviteSecretHash: hash, inviteSecretEncrypted: encrypted })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });

  if (!result) return c.json({ error: 'Organisation not found' }, 404);
  return c.json({ inviteSecret: raw });
});

// ---------------------------------------------------------------------------
// Org notify key management (admin only)
// ---------------------------------------------------------------------------

auth.get('/org/notify-key/status', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const [org] = await db.select({
    hash: organizations.notifyKeyHash,
    prefix: organizations.notifyKeyPrefix,
    lastUsedAt: organizations.notifyKeyLastUsedAt,
  }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  if (!org?.hash) return c.json({ exists: false });
  return c.json({ exists: true, prefix: org.prefix, lastUsedAt: org.lastUsedAt });
});

auth.post('/org/notify-key/generate', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  // Reject if key exists — use rotate instead
  const [org] = await db.select({ hash: organizations.notifyKeyHash })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (org?.hash) {
    return c.json({ error: 'Notify key already exists. Use rotate to replace it.' }, 409);
  }

  const { raw, prefix, hash } = generateNotifyKey();
  await db.update(organizations)
    .set({ notifyKeyHash: hash, notifyKeyPrefix: prefix, notifyKeyLastUsedAt: null })
    .where(eq(organizations.id, orgId));

  return c.json({
    key: raw, prefix,
    warning: 'Save this key now. It cannot be retrieved again.',
  }, 201);
});

auth.post('/org/notify-key/rotate', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const { raw, prefix, hash } = generateNotifyKey();
  const [result] = await db.update(organizations)
    .set({ notifyKeyHash: hash, notifyKeyPrefix: prefix, notifyKeyLastUsedAt: null })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });

  if (!result) return c.json({ error: 'Organisation not found' }, 404);
  return c.json({
    key: raw, prefix,
    warning: 'Save this key now. It cannot be retrieved again. The previous key is now invalid.',
  }, 201);
});

auth.delete('/org/notify-key', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  await db.update(organizations)
    .set({ notifyKeyHash: null, notifyKeyPrefix: null, notifyKeyLastUsedAt: null })
    .where(eq(organizations.id, orgId));

  return c.json({ status: 'revoked' });
});

// ---------------------------------------------------------------------------
// Org membership management
// ---------------------------------------------------------------------------

auth.post('/org/join', requireAuth, async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (orgId) return c.json({ error: 'You already belong to an organisation. Leave it first.' }, 400);

  const parsedJoin = z.object({ inviteSecret: z.string().min(1) }).safeParse(await c.req.json());
  if (!parsedJoin.success) return c.json({ error: 'Invalid input', details: parsedJoin.error.flatten() }, 400);
  const { inviteSecret } = parsedJoin.data;
  const db = getDb();

  const submittedHash = hashInviteSecret(inviteSecret);
  const [org] = await db.select().from(organizations)
    .where(eq(organizations.inviteSecretHash, submittedHash)).limit(1);
  if (!org) return c.json({ error: 'Invalid invite secret' }, 400);

  try {
    await db.insert(orgMemberships).values({ orgId: org.id, userId, role: 'viewer' });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'You already belong to this organisation.' }, 409);
    }
    throw err;
  }

  // Refresh the session so the new orgId and role are immediately reflected.
  // Destroy the current session first to prevent session fixation.
  await destroySession(c);
  await createSession(c, { id: userId, orgId: org.id, role: 'viewer' });

  return c.json({ status: 'joined', org: { id: org.id, name: org.name, slug: org.slug } });
});

auth.post('/org/leave', requireAuth, requireOrg, async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  const db = getDb();

  // Check sole admin
  const [membership] = await db.select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)))
    .limit(1);

  if (membership?.role === 'admin') {
    const adminCount = await db.select({ count: sql<number>`count(*)::int` })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'admin')));

    if (adminCount[0].count <= 1) {
      return c.json({ error: 'You are the only admin. Promote another member or delete the organisation.' }, 400);
    }
  }

  await db.delete(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)));

  // Revoke all API keys the leaving user had for this org
  await db.update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.orgId, orgId)));

  // Invalidate all sessions for this user (orgId is now stale).
  // Sessions are encrypted so JSONB extraction cannot be used; use helper instead.
  await deleteSessionsByUserId([userId]);

  // Destroy the current session cookie
  await destroySession(c);

  return c.json({ status: 'left' });
});

auth.delete('/org', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  // Invalidate all sessions for members of this org before deleting it,
  // since session JSONB stores orgId and has no FK cascade.
  // Sessions are encrypted so JSONB extraction cannot be used; use helper instead.
  await deleteSessionsByOrgId(orgId);

  const [result] = await db.delete(organizations)
    .where(eq(organizations.id, orgId))
    .returning({ name: organizations.name, slug: organizations.slug });

  if (!result) return c.json({ error: 'Organisation not found' }, 404);
  return c.json({ status: 'deleted', org: result });
});

// ---------------------------------------------------------------------------
// Admin: user management
// ---------------------------------------------------------------------------

auth.get('/users', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId');
  const db = getDb();

  const members = await db.select({
    id: users.id, username: users.username, email: users.email,
    role: orgMemberships.role, createdAt: users.createdAt,
  })
    .from(users)
    .innerJoin(orgMemberships, eq(orgMemberships.userId, users.id))
    .where(eq(orgMemberships.orgId, orgId));

  return c.json(members);
});

auth.patch('/users/:id/role', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId')!;
  const currentUserId = c.get('userId')!;
  const targetUserId = c.req.param('id')!;
  const parsedRole = z.object({ role: z.enum(['admin', 'editor', 'viewer']) }).safeParse(await c.req.json());
  if (!parsedRole.success) return c.json({ error: 'Invalid input', details: parsedRole.error.flatten() }, 400);
  const { role } = parsedRole.data;
  const db = getDb();

  // Prevent admin from changing their own role
  if (targetUserId === currentUserId) {
    return c.json({ error: 'Cannot change your own role' }, 400);
  }

  // Prevent demoting the last admin in the org
  if (role !== 'admin') {
    const [{ count: adminCount }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'admin')));

    const [target] = await db.select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.userId, targetUserId), eq(orgMemberships.orgId, orgId)))
      .limit(1);

    if (target?.role === 'admin' && adminCount <= 1) {
      return c.json({ error: 'Cannot demote the last admin. Promote another member first.' }, 400);
    }
  }

  const [result] = await db.update(orgMemberships)
    .set({ role })
    .where(and(eq(orgMemberships.userId, targetUserId), eq(orgMemberships.orgId, orgId)))
    .returning({ userId: orgMemberships.userId, role: orgMemberships.role });

  if (!result) return c.json({ error: 'User not found in this organisation' }, 404);

  // Invalidate all sessions for the target user so stale role is not used.
  // Sessions are encrypted so JSONB extraction cannot be used; use helper instead.
  await deleteSessionsByUserId([targetUserId]);

  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /change-password
// ---------------------------------------------------------------------------

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

auth.post('/change-password', authLimiter, requireAuth, async (c) => {
  const parsedPw = changePasswordSchema.safeParse(await c.req.json());
  if (!parsedPw.success) return c.json({ error: 'Invalid input', details: parsedPw.error.flatten() }, 400);
  const { currentPassword, newPassword } = parsedPw.data;
  const userId = c.get('userId')!;
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return c.json({ error: 'User not found' }, 404);

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.update(users).set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));

  // Invalidate all other sessions for this user (except current).
  // Sessions are encrypted so JSONB extraction cannot be used; use helper instead.
  const currentSid = getCookie(c, 'sentinel.sid');
  if (currentSid) {
    await deleteSessionsByUserIdExcept(userId, currentSid);
  }

  return c.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// DELETE /users/:id -- remove member from org (admin only)
// ---------------------------------------------------------------------------

auth.delete('/users/:id', requireRole('admin'), requireOrg, async (c) => {
  const orgId = c.get('orgId')!;
  const targetUserId = c.req.param('id')!;
  const currentUserId = c.get('userId')!;

  if (targetUserId === currentUserId) {
    return c.json({ error: 'Cannot remove yourself. Use /org/leave instead.' }, 400);
  }

  const db = getDb();
  const [deleted] = await db.delete(orgMemberships)
    .where(and(
      eq(orgMemberships.orgId, orgId),
      eq(orgMemberships.userId, targetUserId),
    ))
    .returning({ userId: orgMemberships.userId });

  if (!deleted) return c.json({ error: 'Member not found' }, 404);

  // Revoke their API keys and invalidate sessions
  await db.update(apiKeys)
    .set({ revoked: true })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.userId, targetUserId)));

  // Sessions are encrypted so JSONB extraction cannot be used; use helper instead.
  await deleteSessionsByUserId([targetUserId]);

  return c.json({ status: 'ok', userId: targetUserId });
});

// ---------------------------------------------------------------------------
// GET /setup-status — public endpoint for first-run setup detection
// ---------------------------------------------------------------------------

auth.get('/setup-status', async (c) => {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations);

  return c.json({ needsSetup: (row?.count ?? 0) === 0 });
});

export { auth as authRouter };
