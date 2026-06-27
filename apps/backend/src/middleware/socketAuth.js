import { eq, and } from 'drizzle-orm';
import { verifyToken } from '../lib/jwt.js';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
export async function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth['token'];
    if (!token) {
        next(new Error('Authentication token required'));
        return;
    }
    let payload;
    try {
        // verifyToken already rejects tokens without a deviceId field.
        payload = verifyToken(token);
    }
    catch {
        next(new Error('Invalid or expired token'));
        return;
    }
    // Bind socket identity from the verified token — never from event payloads.
    // Also confirm the device still exists and has not been revoked.
    const device = await db.query.devices.findFirst({
        where: and(eq(devices.id, payload.deviceId), eq(devices.userId, payload.userId)),
    });
    if (!device || device.isRevoked) {
        next(new Error('Device not found or has been revoked'));
        return;
    }
    socket.auth = payload;
    next();
}
//# sourceMappingURL=socketAuth.js.map