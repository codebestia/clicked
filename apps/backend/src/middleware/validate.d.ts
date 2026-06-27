import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';
export declare function validate(schema: z.ZodTypeAny): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=validate.d.ts.map