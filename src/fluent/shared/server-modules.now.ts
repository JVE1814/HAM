import pkg from '../../../package.json'
import config from '../../../now.config.json'

/**
 * Where the SDK installs the server's entry modules: under the scope, the package name and the package version. A
 * business rule's condition is a script the platform runs as written, so one that calls a module's check loads it with
 * `require('<this>/<file>.ts')`; every other script reaches its module through the import the build rewrites.
 */
export const ENTRY_MODULES = `${config.scope}/${pkg.name}/${pkg.version}/src/server/entry`
