import { z } from 'zod';
/**
 * Startup environment schema. Every variable here is required for the
 * backend to boot; `loadEnv` validates `process.env` against it and exits
 * the process if anything is missing or malformed.
 */
export declare const EnvSchema: z.ZodObject<{
    DATABASE_URL: z.ZodString;
    REDIS_URL: z.ZodString;
    JWT_SECRET: z.ZodString;
    PORT: z.ZodCoercedNumber<unknown>;
    TOKEN_TRANSFER_CONTRACT_ID: z.ZodString;
}, z.core.$strip>;
export type Env = z.infer<typeof EnvSchema>;
/**
 * Validate the given environment (defaults to `process.env`) against
 * `EnvSchema`. On success returns the parsed, typed env and emits no
 * output. On failure it logs the offending variables and exits with code 1.
 *
 * The `source` parameter exists so tests can stub the environment without
 * mutating the real `process.env`.
 */
export declare function loadEnv(source?: NodeJS.ProcessEnv): Env;
//# sourceMappingURL=config.d.ts.map