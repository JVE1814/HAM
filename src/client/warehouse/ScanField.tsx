import React, { useEffect, useRef, useState } from 'react'

/** Input types a user types text into; typing anywhere else on the page is a scan meant for the scan field. */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'number', 'password', 'tel', 'url'])

function takesText(target: EventTarget | null): boolean {
    if (target instanceof HTMLTextAreaElement) return true
    if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type)
    return target instanceof HTMLElement && target.isContentEditable
}

/**
 * A scan input that works with keyboard-wedge scanners (they type the code and press Enter) and, where the browser
 * supports the BarcodeDetector API, with the device camera.
 *
 * It never waits for the server: each code goes to `onScan` at once and the page queues it (scan-queue), so a scan
 * typed while an earlier one is still being sent loses no characters, and a camera scan joins the same queue.
 * `pending` is how many scans are queued or being sent. A key typed while focus is on something that takes no text (a
 * mode button, the Stockroom select, the page itself) is sent to this field, so a scan never lands there and never
 * changes the receiving Stockroom by type-ahead. `inputRef` lets the page return focus here.
 */
export default function ScanField({
    label,
    onScan,
    pending,
    inputRef,
}: {
    label: string
    onScan: (code: string) => void
    pending: number
    inputRef: React.RefObject<HTMLInputElement | null>
}) {
    const [value, setValue] = useState('')
    const [cameraOn, setCameraOn] = useState(false)
    const [cameraError, setCameraError] = useState('')
    const videoRef = useRef<HTMLVideoElement>(null)
    const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia

    useEffect(() => {
        inputRef.current?.focus()
        const redirect = (event: KeyboardEvent) => {
            const input = inputRef.current
            // Printable keys only; a space still presses the focused button or opens the select.
            if (!input || event.key.length !== 1 || event.key === ' ' || event.ctrlKey || event.metaKey || event.altKey) return
            if (event.target === input || takesText(event.target)) return
            // Moved before the key's default action, so the character is typed into the scan field.
            input.focus()
        }
        document.addEventListener('keydown', redirect, true)
        return () => document.removeEventListener('keydown', redirect, true)
    }, [inputRef])

    // Keep the latest callback without restarting the camera when it changes.
    const onScanRef = useRef(onScan)
    onScanRef.current = onScan

    useEffect(() => {
        if (!cameraOn) return
        let cancelled = false
        let stream: MediaStream | undefined
        let timer: number | undefined
        let detecting = false
        const stop = () => {
            cancelled = true
            window.clearInterval(timer)
            stream?.getTracks().forEach((track) => track.stop())
        }
        const fail = (error: unknown) => {
            if (cancelled) return
            stop()
            setCameraOn(false)
            setCameraError(error instanceof Error ? error.message : String(error))
            inputRef.current?.focus()
        }
        let detector: BarcodeDetector
        try {
            detector = new BarcodeDetector({ formats: ['code_128', 'qr_code', 'data_matrix', 'ean_13'] })
        } catch (error) {
            fail(error)
            return
        }
        navigator.mediaDevices
            .getUserMedia({ video: { facingMode: 'environment' } })
            .then((media) => {
                stream = media
                const video = videoRef.current
                if (cancelled || !video) return stop()
                video.srcObject = media
                video.play().catch(fail)
                timer = window.setInterval(() => {
                    if (detecting || cancelled) return
                    detecting = true
                    detector
                        .detect(video)
                        .then(
                            ([code]) => {
                                if (!code?.rawValue || cancelled) return
                                stop()
                                setCameraOn(false)
                                inputRef.current?.focus()
                                onScanRef.current(code.rawValue)
                            },
                            // A frame the detector cannot read (the video not playing yet) holds no code; the next is tried.
                            () => {},
                        )
                        .finally(() => {
                            detecting = false
                        })
                }, 300)
            })
            .catch(fail)
        return stop
    }, [cameraOn, inputRef])

    const submit = (event: React.FormEvent) => {
        event.preventDefault()
        const code = value.trim()
        if (!code) return
        setValue('')
        onScan(code)
        // The emptied field disables Go, which would drop focus to the page after a tap on it.
        inputRef.current?.focus()
    }

    const toggleCamera = () => {
        setCameraError('')
        setCameraOn((on) => !on)
    }

    return (
        <form className="scan" onSubmit={submit}>
            <label htmlFor="scan-input">{label}</label>
            <div className="scan-row">
                <input
                    id="scan-input"
                    ref={inputRef}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    placeholder="Scan or type serial / tag"
                />
                <button type="submit" disabled={!value.trim()}>
                    Go
                </button>
                {cameraSupported && (
                    <button type="button" onClick={toggleCamera}>
                        {cameraOn ? 'Stop camera' : 'Camera'}
                    </button>
                )}
            </div>
            {pending > 0 && (
                <p className="scan-pending" role="status">
                    Sending {pending} {pending === 1 ? 'scan' : 'scans'}…
                </p>
            )}
            {cameraError && <p className="scan-error">Camera unavailable: {cameraError}</p>}
            {cameraOn && <video ref={videoRef} className="camera" muted playsInline />}
        </form>
    )
}
