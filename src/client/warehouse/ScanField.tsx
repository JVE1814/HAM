import React, { useEffect, useRef, useState } from 'react'

/**
 * A scan input that works with keyboard-wedge scanners (they type the code and press Enter) and,
 * where the browser supports the BarcodeDetector API, with the device camera.
 */
export default function ScanField({ label, onScan, busy }: { label: string; onScan: (code: string) => void; busy: boolean }) {
    const [value, setValue] = useState('')
    const [cameraOn, setCameraOn] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const videoRef = useRef<HTMLVideoElement>(null)
    const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window

    useEffect(() => {
        if (!busy) inputRef.current?.focus()
    }, [busy])

    useEffect(() => {
        if (!cameraOn) return
        let stream: MediaStream | undefined
        let timer: number | undefined
        const detector = new BarcodeDetector({ formats: ['code_128', 'qr_code', 'data_matrix', 'ean_13'] })
        navigator.mediaDevices
            .getUserMedia({ video: { facingMode: 'environment' } })
            .then((media) => {
                stream = media
                if (!videoRef.current) return
                videoRef.current.srcObject = media
                void videoRef.current.play()
                timer = window.setInterval(async () => {
                    if (!videoRef.current) return
                    const [code] = await detector.detect(videoRef.current)
                    if (code?.rawValue) {
                        setCameraOn(false)
                        onScan(code.rawValue)
                    }
                }, 300)
            })
            .catch(() => setCameraOn(false))
        return () => {
            window.clearInterval(timer)
            stream?.getTracks().forEach((track) => track.stop())
        }
    }, [cameraOn, onScan])

    const submit = (event: React.FormEvent) => {
        event.preventDefault()
        const code = value.trim()
        if (!code) return
        setValue('')
        onScan(code)
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
                    disabled={busy}
                    placeholder="Scan or type serial / tag"
                />
                <button type="submit" disabled={busy || !value.trim()}>
                    Go
                </button>
                {cameraSupported && (
                    <button type="button" onClick={() => setCameraOn((on) => !on)} disabled={busy}>
                        {cameraOn ? 'Stop camera' : 'Camera'}
                    </button>
                )}
            </div>
            {cameraOn && <video ref={videoRef} className="camera" muted playsInline />}
        </form>
    )
}
