import jwt from 'jsonwebtoken';
const SECRET = process.env['JWT_SECRET'];
if (!SECRET) {
    throw new Error('JWT_SECRET is not set');
}
const JWT_SECRET = SECRET;
export function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
export function verifyToken(token) {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Reject legacy tokens that pre-date device-aware auth.
    if (!decoded.deviceId) {
        throw new Error('Token missing deviceId — re-authentication required');
    }
    return decoded;
}
//# sourceMappingURL=jwt.js.map