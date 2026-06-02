import { Router, type Router as RouterType } from 'express';
import { eq, and, or, ilike, exists, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis } from '../lib/redis.js';
import { isOnline } from '../services/presence.js';

export const usersRouter: RouterType = Router();

usersRouter.use(requireAuth);

usersRouter.get('/search', async (req: AuthRequest, res) => {
  const raw = req.query['q'];
  const q = typeof raw === 'string' ? raw.trim() : '';

  if (!q) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  // Escape LIKE wildcards so user input is treated literally in the prefix match.
  const prefix = `${q.replace(/[\\%_]/g, '\\$&')}%`;

  try {
    const results = await db.query.users.findMany({
      where: or(
        ilike(users.username, prefix),
        exists(
          db
            .select({ one: sql`1` })
            .from(wallets)
            .where(and(eq(wallets.userId, users.id), eq(wallets.address, q))),
        ),
      ),
      columns: {
        id: true,
        username: true,
        avatarUrl: true,
      },
      with: {
        wallets: {
          columns: { address: true, isPrimary: true },
        },
      },
      limit: 10,
    });

    res.json(
      results.map((user) => ({
        id: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        primaryWalletAddress: user.wallets.find((w) => w.isPrimary)?.address ?? null,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Search failed' });
  }
});

usersRouter.get('/:id', async (req: AuthRequest, res) => {
  const id = req.params['id'] as string;

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        id: true,
        username: true,
        avatarUrl: true,
      },
      with: {
        wallets: {
          columns: {
            address: true,
            isPrimary: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      wallets: user.wallets.map((w) => ({
        address: w.address,
        isPrimary: w.isPrimary,
      })),
    });
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

usersRouter.get('/:id/presence', async (req: AuthRequest, res) => {
  const id = req.params['id'] as string;
  if (!redis) {
    res.json({ online: false });
    return;
  }
  const online = await isOnline(redis, id);
  res.json({ online });
});

usersRouter.patch('/me', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const { username, avatarUrl } = req.body;

  const updateData: Partial<typeof users.$inferInsert> = {};

  if (avatarUrl !== undefined) {
    updateData.avatarUrl = avatarUrl;
  }

  if (username !== undefined) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      res.status(400).json({ error: 'Username must be 3-30 alphanumeric characters and underscores only' });
      return;
    }

    // Check conflict
    const existing = await db.query.users.findFirst({
      where: eq(users.username, username),
    });
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: 'Username is already taken' });
      return;
    }

    updateData.username = username;
  }

  updateData.updatedAt = new Date();

  try {
    const [updatedUser] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(updatedUser);
  } catch (err) {
    res.status(409).json({ error: 'Username conflict or database error' });
  }
});

