import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import nowConfig from './now.config.json' with { type: 'json' }
import { execFileSync } from 'node:child_process'

/** What git ignores is no source: .gitignore, .git/info/exclude and the user's own excludes, so a scratch folder needs no entry here. */
const GIT_IGNORED = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
})
    .split('\0')
    .filter(Boolean)
    .map((path) => (path.endsWith('/') ? `${path}**` : path))

/**
 * The instance stores each server module as a sys_module whose path ends in ".ts" and resolves an import by that exact
 * path, so a relative import without the extension builds and passes every unit test, then fails on the instance the
 * first time its module loads. Each layer block below names it; a server file outside the layers already fails.
 */
const EXTENSIONLESS = {
    regex: '^\\.{1,2}/.*(?<!\\.ts|\\.json)$',
    message: 'Name the .ts file: the instance resolves a server module import by its exact path.',
}

/** The build installs a server module that imports JSON with an import the instance cannot resolve, and every check passes. */
const JSON_IMPORT = {
    regex: '\\.json$',
    message: 'A server module cannot import JSON: the instance cannot resolve it. Write the value out.',
}

const SERVER_FILES = 'src/server/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'

/** Test code: what the build leaves out of the server modules, so the layer rules do not apply to it. */
const TEST_CODE = nowConfig.serverModulesExcludePatterns.map((pattern) => `src/server/${pattern}`)

const STATIC_IMPORTS = { selector: 'ImportExpression', message: 'A server module imports statically, so the layer rules see it (ADR 0003).' }

export default tseslint.config(
    {
        ignores: [
            ...GIT_IGNORED,
            '.claude/**',
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
    // A page shares the pure domain core with the server and nothing else of it: platform and entry modules need Glide.
    {
        files: ['src/client/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
        rules: {
            'no-restricted-imports': [
                'error',
                { patterns: [{ regex: '/server/(?!domain/)', message: 'A page imports server code from server/domain only.' }] },
            ],
        },
    },
    // ADR 0003: the layer rules below see only static imports, and only of modules in a layer's folder.
    {
        files: [SERVER_FILES],
        ignores: TEST_CODE,
        rules: { 'no-restricted-syntax': ['error', STATIC_IMPORTS] },
    },
    // An administrator picks the app's lines out of the system log by the scope that platform/log leads each with.
    {
        files: [SERVER_FILES],
        ignores: [...TEST_CODE, 'src/server/platform/log.ts'],
        rules: {
            'no-restricted-properties': [
                'error',
                ...['info', 'warn', 'error'].map((property) => ({ object: 'gs', property, message: 'Log through platform/log, which leads the line with the scope.' })),
            ],
        },
    },
    // A save without the business rules gets past the closed Billing period's lock, so it is made in one module.
    {
        files: ['src/server/{domain,platform,entry}/**/*.ts'],
        ignores: [...TEST_CODE, 'src/server/platform/closed-period.ts', 'src/server/platform/records.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                STATIC_IMPORTS,
                {
                    selector: "CallExpression[callee.property.name='setWorkflow']",
                    message: 'A write past the business rules gets past the closed Billing period lock: make it in platform/closed-period.',
                },
            ],
        },
    },
    {
        files: [SERVER_FILES],
        ignores: [...TEST_CODE, 'src/server/{domain,platform,entry}/**'],
        rules: {
            'no-restricted-syntax': [
                'error',
                { selector: 'Program', message: 'A server module sits in domain/, platform/ or entry/ (ADR 0003); test code in test-support/.' },
            ],
        },
    },
    // ADR 0003: the domain core never reaches Glide or the layers above it, and platform never reaches entry.
    {
        files: ['src/server/domain/**/*.ts'],
        ignores: TEST_CODE,
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        JSON_IMPORT,
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
        ignores: TEST_CODE,
        rules: {
            'no-restricted-imports': [
                'error',
                { patterns: [JSON_IMPORT, EXTENSIONLESS, { regex: '/entry/', message: 'Platform never imports entry points (ADR 0003).' }] },
            ],
        },
    },
    // ADR 0003: an entry module wires triggers to services and is no other entry module's library.
    {
        files: ['src/server/entry/**/*.ts'],
        ignores: TEST_CODE,
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        JSON_IMPORT,
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
    // The layer rules above read .ts files only, so a server module in any other form would pass them all.
    {
        files: ['src/server/**/*.{tsx,mts,cts,js,mjs,cjs}'],
        rules: {
            'no-restricted-syntax': ['error', { selector: 'Program', message: 'A server module is a .ts file, which the layer rules read.' }],
        },
    },
)
