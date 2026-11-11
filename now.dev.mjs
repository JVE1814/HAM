import { createServer } from 'vite'
import { createViteProxy, DEFAULT_PROXY_PATHS } from '@servicenow/isomorphic-rollup/vite'
import { clientConfig } from './now.vite.mjs'

/** Serves the UI pages from source, the instance's APIs proxied with the SDK's credential: /<page>.html, e.g. /workspace.html. */
export default async ({ rootDir, config, path, logger, credential }) => {
    const server = await createServer({
        ...(await clientConfig({ rootDir, config, path })),
        // The SDK's `/api` prefix would also send src/client/api.ts (served as /api.ts) to the instance.
        server: { proxy: await createViteProxy(credential, DEFAULT_PROXY_PATHS.map((p) => (p === '/api' ? '/api/' : p))) },
    })
    await server.listen()
    logger.info(`UI pages served at ${server.resolvedUrls?.local[0]}`)
    return new Promise(() => {})
}
