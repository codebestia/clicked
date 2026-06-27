import type { Request, Response, NextFunction } from 'express';
import { type JwtPayload } from '../lib/jwt.js';
export interface AuthRequest extends Request {
    auth?: JwtPayload;
}
export declare function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
//# sourceMappingURL=auth.d.ts.map