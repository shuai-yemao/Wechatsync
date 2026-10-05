import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LocalImportPage } from './LocalImportPage'
import '../popup/styles/globals.css'

createRoot(document.getElementById('root')!).render(<StrictMode><LocalImportPage /></StrictMode>)
