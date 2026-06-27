import { eq, and } from 'drizzle-orm';
import { verifyToken } from '../lib/jwt.js';
import { db } from '../db/index.js';
import { devices } from '../db/schema.js';
export async function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
        return;
    }
    const token = header.slice(7);
    let payload;
    try {
        payload = verifyToken(token);
    }
    catch {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
    }
    if (!payload.deviceId) {
        res.status(401).json({ error: 'Token missing deviceId' });
        return;
    }
    // Verify the (userId, deviceId) pair exists and is not revoked.
    const device = await db.query.devices.findFirst({
        where: and(eq(devices.id, payload.deviceId), eq(devices.userId, payload.userId)),
    });
    if (!device || device.isRevoked) {
        res.status(401).json({ error: 'Device not found or has been revoked' });
        return;
    }
    req.auth = payload;
    next();
}
//# sourceMappingURL=auth.js.map