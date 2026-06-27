import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadEnv, EnvSchema } from '../config.js';
const validEnv = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-secret',
    PORT: '3001',
    TOKEN_TRANSFER_CONTRACT_ID: 'CONTRACT123',
};
describe('loadEnv', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('returns parsed env and emits no output for a valid environment', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const env = loadEnv({ ...validEnv });
        expect(env).toEqual({
            DATABASE_URL: 'postgres://localhost/test',
            REDIS_URL: 'redis://localhost:6379',
            JWT_SECRET: 'test-secret',
            PORT: 3001,
            TOKEN_TRANSFER_CONTRACT_ID: 'CONTRACT123',
        });
        expect(errorSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });
    it('logs the missing variable and exits with code 1 when DATABASE_URL is absent', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }));
        const { DATABASE_URL: _omitted, ...withoutDbUrl } = validEnv;
        const _ = _omitted; // eslint-disable-line @typescript-eslint/no-unused-vars
        expect(() => loadEnv(withoutDbUrl)).toThrow('process.exit called');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('DATABASE_URL');
    });
    it('reports every missing variable on an empty environment', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }));
        expect(() => loadEnv({})).toThrow('process.exit called');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        for (const key of Object.keys(validEnv)) {
            expect(logged).toContain(key);
        }
    });
    it('rejects a non-numeric PORT', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit called');
        }));
        expect(() => loadEnv({ ...validEnv, PORT: 'not-a-number' })).toThrow('process.exit called');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')).toContain('PORT');
    });
    it('coerces a numeric PORT string to a number', () => {
        const parsed = EnvSchema.parse({ ...validEnv, PORT: '8080' });
        expect(parsed.PORT).toBe(8080);
    });
});
//# sourceMappingURL=config.test.js.map