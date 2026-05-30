import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { attachRedisAdapter } from './socket/redisAdapter.js';
import { app } from './app.js';
import {
  buildRpcFetcher,
  runForever as runStellarListener,
} from './services/stellarListener.js';

dotenv.config();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

void attachRedisAdapter(io);

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
