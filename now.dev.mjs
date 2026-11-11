import { createServer } from 'vite'
import { createViteProxy, DEFAULT_PROXY_PATHS } from '@servicenow/isomorphic-rollup/vite'
import { clientConfig } from './now.vite.mjs'

/** Serves the UI pages from source, the instance's APIs proxied with the SDK's credential: /<page>.html, e.g. /workspace.html. */
export default async ({ rootDir, config, path, logger, credential }) => {
    const server = await createServer({
        ...(await clientConfig({ rootDir, config, path })),
        // '/api/', not '/api': the prefix alone also matches the page module /api.ts.
        server: { proxy: await createViteProxy(credential, DEFAULT_PROXY_PATHS.map((path) => (path === '/api' ? '/api/' : path))) },
    })
    await server.listen()
    logger.info(`UI pages served at ${server.resolvedUrls?.local[0]}`)
    return new Promise(() => {})
}
