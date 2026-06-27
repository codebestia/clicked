import { describe, it, expect } from 'vitest';
import express, {} from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
const TestSchema = z.object({
    name: z.string().min(1, 'name is required'),
    age: z.number().int('age must be an integer'),
});
function makeApp() {
    const app = express();
    app.use(express.json());
    app.post('/test', validate(TestSchema), (req, res) => {
        res.json({ received: req.body });
    });
    return app;
}
describe('validate middleware', () => {
    const app = makeApp();
    it('calls next and passes body through on valid input', async () => {
        const res = await request(app).post('/test').send({ name: 'Alice', age: 30 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: { name: 'Alice', age: 30 } });
    });
    it('returns 400 with structured error on missing required field', async () => {
        const res = await request(app).post('/test').send({ age: 25 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(Array.isArray(res.body.issues)).toBe(true);
        const fields = res.body.issues.map((i) => i.field);
        expect(fields).toContain('name');
    });
    it('returns 400 with structured error on wrong type', async () => {
        const res = await request(app).post('/test').send({ name: 'Bob', age: 'not-a-number' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.issues[0]).toHaveProperty('field');
        expect(res.body.issues[0]).toHaveProperty('message');
    });
    it('returns 400 with error for empty body', async () => {
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.issues.length).toBeGreaterThan(0);
    });
    it('issues array entries have field and message keys', async () => {
        const res = await request(app).post('/test').send({ age: 10 });
        expect(res.status).toBe(400);
        for (const issue of res.body.issues) {
            expect(issue).toHaveProperty('field');
            expect(issue).toHaveProperty('message');
            expect(typeof issue.field).toBe('string');
            expect(typeof issue.message).toBe('string');
        }
    });
});
describe('auth route validation via validate middleware', () => {
    it('validate middleware integrates as Express RequestHandler', () => {
        const handler = validate(TestSchema);
        expect(typeof handler).toBe('function');
        // Ensure it accepts (req, res, next) signature
        expect(handler.length).toBe(3);
    });
});
//# sourceMappingURL=validate.test.js.map