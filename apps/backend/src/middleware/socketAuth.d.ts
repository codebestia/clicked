import type { Socket } from 'socket.io';
import { type JwtPayload } from '../lib/jwt.js';
export interface AuthSocket extends Socket {
    auth?: JwtPayload;
}
export declare function socketAuthMiddleware(socket: AuthSocket, next: (err?: Error) => void): Promise<void>;
//# sourceMappingURL=socketAuth.d.ts.map