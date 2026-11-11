import tailwindcss from '@tailwindcss/vite'
import { uiPageSourceManifest } from '@servicenow/isomorphic-rollup'
import { servicenowVitePlugins } from '@servicenow/isomorphic-rollup/vite'

/**
 * Every emitted file named by its content: the instance serves /uxasset and /uxta files from a cache keyed by path,
 * with a year's expiry, so changed content needs a new name. The ServiceNow plugins name scripts without a hash.
 */
const contentHashedNames = {
    name: 'content-hashed-names',
    apply: 'build',
    enforce: 'post',
    outputOptions(options) {
        return { ...options, entryFileNames: '[name]-[hash].jsdbx', chunkFileNames: '[name]-[hash].jsdbx', assetFileNames: 'assets/[name]-[hash][extname]' }
    },
}

/**
 * A page needs the stylesheets of every chunk its entry imports, and the ServiceNow HTML plugin links an entry chunk's
 * own only: the pages' shared stylesheet sits with their shared code, in a chunk no entry is.
 */
const linkImportedCss = {
    name: 'link-imported-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
        const stylesheets = (fileName, seen) => {
            const chunk = bundle[fileName]
            if (chunk?.type !== 'chunk' || seen.has(fileName)) return []
            seen.add(fileName)
            return [...(chunk.viteMetadata?.importedCss ?? []), ...chunk.imports.flatMap((imported) => stylesheets(imported, seen))]
        }
        for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk' || !chunk.isEntry) continue
            for (const file of stylesheets(chunk.fileName, new Set())) chunk.viteMetadata.importedCss.add(file)
        }
    },
}

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
            linkImportedCss,
            ...(await servicenowVitePlugins({ scope: config.scope, rootDir: clientDir, registerExplicitId, enableCacheBusting: true })),
            contentHashedNames,
            ...(config.packageSourceCodeOnInstance ? [{ ...uiPageSourceManifest({ rootDir, clientDir }), enforce: 'post' }] : []),
        ],
        build: {
            outDir: path.join(rootDir, config.staticContent.buildDir),
            emptyOutDir: true,
            sourcemap: true,
            rollupOptions: { input: path.join(clientDir, '*.html') },
        },
    }
}
