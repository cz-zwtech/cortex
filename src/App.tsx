import { useEffect } from 'react'
import { Shell } from './app/shell/Shell'

export default function App() {
  useEffect(() => {
    // Suppress the browser's native context menu so our custom one can show.
    // Inputs/textareas/contenteditable keep their native menu (e.g. copy/paste).
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const isEditable =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      if (!isEditable) e.preventDefault()
    }
    // capture:true intercepts before Firefox's own handler fires
    document.addEventListener('contextmenu', handler, true)
    return () => document.removeEventListener('contextmenu', handler, true)
  }, [])

  return <Shell />
}
