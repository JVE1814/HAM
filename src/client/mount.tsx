import React from 'react'
import ReactDOM from 'react-dom/client'
import './base.css'

export function mount(App: React.ComponentType): void {
    const root = document.getElementById('root')
    if (root) {
        ReactDOM.createRoot(root).render(
            <React.StrictMode>
                <App />
            </React.StrictMode>,
        )
    }
}
