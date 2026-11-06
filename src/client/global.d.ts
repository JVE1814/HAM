// handles importing scss as modules
declare module '*.scss' {
    const content: string
    export default content
}

declare module '*.css'

interface Window {
    /** Session token ServiceNow injects into UI pages; sent as X-UserToken on REST calls. */
    g_ck: string
}

/** Shape Detection API (Chrome/Android); not yet in TypeScript's DOM lib. */
interface DetectedBarcode {
    rawValue: string
}
declare class BarcodeDetector {
    constructor(options?: { formats?: string[] })
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
