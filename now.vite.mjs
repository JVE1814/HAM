import tailwindcss from '@tailwindcss/vite'
import { uiPageSourceManifest } from '@servicenow/isomorphic-rollup'
import { servicenowVitePlugins } from '@servicenow/isomorphic-rollup/vite'

/** The Vite config of the UI pages (src/client/*.html), shared by the build (now.prebuild.mjs) and the dev server (now.dev.mjs). */
export async function clientConfig({ rootDir, config, path, registerExplicitId }) {
    const clientDir = path.join(rootDir, config.clientDir)
    return {
        configFile: false,
        logLevel: 'warn',
        root: clientDir,
        resolve: { alias: { '@': clientDir } },
        // The dev server compiles JSX with esbuild; the build's SWC plugin uses the same automatic runtime.
        esbuild: { jsx: 'automatic' },
        optimizeDeps: { entries: ['*.html'] },
        plugins: [
            tailwindcss(),
            ...(await servicenowVitePlugins({ scope: config.scope, rootDir: clientDir, registerExplicitId, enableCacheBusting: true })),
            ...(config.packageSourceCodeOnInstance ? [{ ...uiPageSourceManifest({ rootDir, clientDir }), enforce: 'post' }] : []),
        ],
        build: {
            outDir: path.join(rootDir, config.staticContent.buildDir),
            emptyOutDir: true,
            sourcemap: true,
            // Unhashed names: each emitted file is a record on the instance, keyed by its name in keys.ts.
            rollupOptions: { input: path.join(clientDir, '*.html'), output: { assetFileNames: 'assets/[name][extname]' } },
        },
    }
}
