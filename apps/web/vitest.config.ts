import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@': rootDir,
        },
    },
    test: {
        environment: 'node',
        // evals/ holds the deterministic contract-quality suite; it replays fixtures, so it runs in CI.
        include: ['lib/**/*.test.ts', 'evals/**/*.test.ts'],
        // Transform AuthKit's Next.js imports through Vite instead of native Node ESM.
        server: { deps: { inline: ['@workos-inc/authkit-nextjs'] } },
    },
});

