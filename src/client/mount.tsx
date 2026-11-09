import React from 'react'
import ReactDOM from 'react-dom/client'
import './base.css'

/** Renders a page's App into the `root` element of its UI page. */
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
