import { gs } from '@servicenow/glide'

/**
 * The app's lines in the system log, each led by its scope so an administrator can pick them out of the platform's.
 * The scope is written out: a server module that imports now.config.json installs with an import the instance cannot
 * resolve.
 */
const PREFIX = '[x_daas_ham]'

export const log = {
    info: (message: string): void => gs.info(`${PREFIX} ${message}`),
    warn: (message: string): void => gs.warn(`${PREFIX} ${message}`),
    error: (message: string): void => gs.error(`${PREFIX} ${message}`),
}
