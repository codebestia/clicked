import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMembers } from './db/schema.js';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { app } from './app.js';
import { redis as appRedis } from './lib/redis.js';
import { setSocketServer } from './lib/socket.js';
import { setOnline, setOffline, refreshPresence } from './services/presence.js';
import {
  buildRpcFetcher,
  buildTreasuryRpcFetcher,
  runForever as runStellarListener,
} from './services/stellarListener.js';
import { loadEnv } from './config.js';

dotenv.config();

// Validate required environment variables at boot. Exits with code 1 and
// logs the offending vars if anything is missing or malformed.
loadEnv();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

setSocketServer(io);

io.use(socketAuthMiddleware);

io.on('connection', async (socket: AuthSocket) => {
  const userId = socket.auth!.userId;
  console.log('User connected:', userId, socket.id);

  // Auto-join all conversation rooms so the socket receives new_message events
  // for every conversation the user belongs to (needed for unread badge tracking).
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, userId),
    columns: { conversationId: true },
  });
  for (const m of memberships) {
    await socket.join(m.conversationId);
  }

  if (appRedis) {
    await setOnline(appRedis, userId, socket.id);
    for (const m of memberships) {
      io.to(m.conversationId).emit('user_online', { userId });
      io.to(m.conversationId).emit('presence_update', { userId, online: true });
    }
  }

  socket.on('heartbeat', async () => {
    if (appRedis) {
      await refreshPresence(appRedis, userId);
    }
  });

  registerMessagingHandlers(io, socket);

  socket.on('disconnect', async () => {
    console.log('User disconnected:', userId);
    if (appRedis) {
      const fullyOffline = await setOffline(appRedis, userId, socket.id);
      if (fullyOffline) {
        const memberships = await db.query.conversationMembers.findMany({
          where: eq(conversationMembers.userId, userId),
          columns: { conversationId: true },
        });
        for (const m of memberships) {
          io.to(m.conversationId).emit('user_offline', { userId });
          io.to(m.conversationId).emit('presence_update', { userId, online: false });
        }
      }
    }
  });
});

/**
 * Issue #7 — Redis pub/sub adapter for horizontal Socket.IO scaling.
 *
 * When `REDIS_URL` is reachable, attach `@socket.io/redis-adapter` so
 * multiple backend instances share rooms via Redis pub/sub. If the
 * connection fails (Redis down, wrong URL, or env var unset), log a
 * warning and continue running in single-instance mode — the in-process
 * adapter remains active so the server still works locally.
 */
async function attachRedisAdapter(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => {
    console.warn('[socket.io] Redis pub client error — degrading to local adapter:', err.message);
  });
  subClient.on('error', (err) => {
    console.warn('[socket.io] Redis sub client error — degrading to local adapter:', err.message);
  });

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log(`[socket.io] Redis adapter attached (${redisUrl})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[socket.io] Redis unavailable (${message}) — running in single-instance mode`);
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  }
}

const PORT = process.env['PORT'] ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// Attach the Redis adapter after listen() so the API is reachable even if
// Redis is unreachable; on failure we fall back to the in-process adapter.
void attachRedisAdapter();

// #46 — Stellar transfer event listener. Only spin up when the contract
// id is configured so local-dev and unit-test runs don't try to talk to
// Soroban RPC. The listener never throws out of runForever, so a failed
// chain connection logs but doesn't crash the API.
const stellarRpcUrl = process.env['STELLAR_RPC_URL'];
const tokenTransferContractId = process.env['TOKEN_TRANSFER_CONTRACT_ID'];
const groupTreasuryContractId = process.env['GROUP_TREASURY_CONTRACT_ID'];

if (stellarRpcUrl && tokenTransferContractId) {
  void runStellarListener({
    fetchEvents: buildRpcFetcher({
      rpcUrl: stellarRpcUrl,
      contractId: tokenTransferContractId,
    }),
    ...(groupTreasuryContractId && {
      fetchTreasuryEvents: buildTreasuryRpcFetcher({
        rpcUrl: stellarRpcUrl,
        contractId: groupTreasuryContractId,
      }),
    }),
  });
} else {
  console.log(
    '[stellar-listener] STELLAR_RPC_URL or TOKEN_TRANSFER_CONTRACT_ID unset; listener disabled.',
  );
}
