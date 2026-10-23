import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000, env: { NODE_ENV: 'test', DATA_DIR: './data-test', LOG_LEVEL: 'silent', JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234567890', APP_ENC_KEY: 'test-enc-key-test-enc-key-1234567890-abcdef' } } });
