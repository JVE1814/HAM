import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

const EXTENSIONLESS = {
    regex: '^\\.{1,2}/.*(?<!\\.ts|\\.json)$',
    message: 'Name the .ts file: the instance resolves a server module import by its exact path.',
}

/*
 * Entry modules that still import a sibling entry module, each for an operation that has yet to move to a platform
 * service: delivery (the outbound label, entry/shipping). Remove a file from this list as its import goes.
 */
const ENTRY_STILL_IMPORTING_ENTRY = ['src/server/entry/delivery.ts']

export default tseslint.config(
    {
        ignores: [
            'node_modules/**',
            '.claude/**',
            'dist/**',
            'target/**',
            '.now/**',
            '@types/**',
            'src/fluent/generated/**',
            'now.prebuild.mjs',
            'now.dev.mjs',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { globals: { ...globals.es2021 } },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['src/client/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
    },
    // The instance stores each server module as a sys_module whose path ends in ".ts" and resolves an import by that
    // exact path, so a relative import without the extension builds and passes every unit test, then fails on the
    // instance the first time its module loads.
    {
        files: ['src/server/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: { 'no-restricted-imports': ['error', { patterns: [EXTENSIONLESS] }] },
    },
    // ADR 0003: the domain core never reaches Glide or the layers above it, and platform never reaches entry.
    {
        files: ['src/server/domain/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        EXTENSIONLESS,
                        { regex: '^@servicenow/glide', message: 'The domain core never imports Glide (ADR 0003).' },
                        { regex: '/(platform|entry)/', message: 'The domain core imports nothing above it (ADR 0003).' },
                    ],
                },
            ],
        },
    },
    {
        files: ['src/server/platform/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                { patterns: [EXTENSIONLESS, { regex: '/entry/', message: 'Platform never imports entry points (ADR 0003).' }] },
            ],
        },
    },
    // ADR 0003: an entry module wires triggers to services and is no other entry module's library.
    {
        files: ['src/server/entry/**/*.ts'],
        ignores: ['**/*.test.ts', ...ENTRY_STILL_IMPORTING_ENTRY],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        EXTENSIONLESS,
                        {
                            regex: '^\\./|/entry/',
                            message: 'An entry module never imports another: move the operation to a platform service (ADR 0003).',
                        },
                    ],
                },
            ],
        },
    },
)
