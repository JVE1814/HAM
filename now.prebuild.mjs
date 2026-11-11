import { servicenowFrontEndPlugins, rollup, glob } from '@servicenow/isomorphic-rollup'

/**
 * Export an async function that accepts useful modules for building the application as arguments.
 * This function returns a Promise that resolves when the build is complete.
 * You can also export an array of functions if you want to run multiple prebuild steps.
 */
export default async ({ rootDir, config, fs, path, logger, registerExplicitId }) => {
    const clientDir = path.join(rootDir, config.clientDir)
    const htmlFilePattern = path.join(clientDir, '**', '*.html')
    const htmlFiles = await glob(htmlFilePattern, { fs })
    if (!htmlFiles.length) {
        logger.warn(`No HTML files found in ${clientDir}, skipping UI build.`)
        return
    }

    const staticContentDir = path.join(rootDir, config.staticContent.buildDir)
    fs.rmSync(staticContentDir, { recursive: true, force: true })

    const rollupBundle = await rollup({
        fs,
        input: htmlFilePattern,
        plugins: [
            servicenowFrontEndPlugins({
                scope: config.scope,
                rootDir: clientDir,
                projectRootDir: rootDir,
                registerExplicitId,
                // When true -- Pages built with NowSDK will be editable on instance and through Build Agent
                //
                //   Set editableSourceCodeOnInstance to the value below to override
                //   which files are included when deployed to a ServiceNow instance
                //   editableSourceCodeOnInstance: {
                //       excludePatterns: [
                //         '**/node_modules/**',
                //         '**/dist/**',
                //         '**/build/**',
                //         '**/.now/**',
                //         '**/.git/**',
                //         '**/*.min.js',
                //         '**/*.bundle.js',
                //     ],
                //   },
                editableSourceCodeOnInstance: config.packageSourceCodeOnInstance,
            }),
        ],
    })
    const rollupOutput = await rollupBundle.write({
        dir: staticContentDir,
        sourcemap: true,
    })
    rollupOutput.output.forEach((file) => {
        if (file.type === 'asset') {
            logger.info(`Bundled asset: ${file.fileName} (${file.source.length} bytes)`)
        } else if (file.type === 'chunk') {
            logger.info(`Bundled chunk: ${file.fileName} (${file.code.length} bytes)`)
        }
    })
}
