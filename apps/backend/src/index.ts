import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { app } from './app.js';
import {
  buildRpcFetcher,
  runForever as runStellarListener,
} from './services/stellarListener.js';
import { attachRedisAdapter } from './socket/redis-adapter.js';

dotenv.config();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

io.use(socketAuthMiddleware);

io.on('connection', (socket: AuthSocket) => {
  console.log('User connected:', socket.auth?.userId, socket.id);
  registerMessagingHandlers(io, socket);
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.auth?.userId);
  });
});

const PORT = process.env['PORT'] ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// #7 — attach the Redis pub/sub adapter so multiple instances share
// Socket.IO rooms. Done after listen() so the API is reachable even if
// Redis is unreachable; the helper logs + falls back to the in-memory
// adapter on failure.
void attachRedisAdapter(io).then((result) => {
  if (result.attached) {
    console.log('[socket.io] Redis adapter attached for horizontal scaling');
  } else {
    console.log(
      `[socket.io] Redis adapter NOT attached — falling back to in-memory ` +
        `adapter. Reason: ${result.reason}`,
    );
  }
});

// #46 — Stellar transfer event listener. Only spin up when the contract
// id is configured so local-dev and unit-test runs don't try to talk to
// Soroban RPC. The listener never throws out of runForever, so a failed
// chain connection logs but doesn't crash the API.
const stellarRpcUrl = process.env['STELLAR_RPC_URL'];
const tokenTransferContractId = process.env['TOKEN_TRANSFER_CONTRACT_ID'];
if (stellarRpcUrl && tokenTransferContractId) {
  void runStellarListener({
    fetchEvents: buildRpcFetcher({
      rpcUrl: stellarRpcUrl,
      contractId: tokenTransferContractId,
    }),
  });
} else {
  console.log(
    '[stellar-listener] STELLAR_RPC_URL or TOKEN_TRANSFER_CONTRACT_ID unset; listener disabled.',
  );
}
