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
    // tsconfig's `jsx: preserve` leaves JSX to Next.js; component tests need it compiled here.
    oxc: { jsx: { runtime: 'automatic' } },
    test: {
        // Transform AuthKit's Next.js imports through Vite instead of native Node ESM.
        server: { deps: { inline: ['@workos-inc/authkit-nextjs'] } },
        projects: [
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    // evals/ holds the deterministic contract-quality suite; it replays fixtures, so it runs in CI.
                    include: ['lib/**/*.test.ts', 'evals/**/*.test.ts'],
                },
            },
            {
                extends: true,
                test: {
                    // React component tests with Testing Library; jsdom runs Radix Dialog's portal and focus handling.
                    name: 'components',
                    environment: 'jsdom',
                    include: ['components/**/*.test.tsx'],
                    setupFiles: ['./vitest.setup.ts'],
                },
            },
        ],
    },
});
