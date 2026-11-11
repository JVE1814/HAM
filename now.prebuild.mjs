import { build } from 'vite'
import { clientConfig } from './now.vite.mjs'

/** Builds the UI pages with Vite before the rest of the build, so Tailwind compiles the pages' stylesheet. */
export default async ({ rootDir, config, path, logger, registerExplicitId }) => {
    const output = await build(await clientConfig({ rootDir, config, path, registerExplicitId }))
    for (const result of [output].flat()) {
        for (const file of result.output) {
            const size = file.type === 'asset' ? file.source.length : file.code.length
            logger.info(`Bundled ${file.type}: ${file.fileName} (${size} bytes)`)
        }
    }
}
