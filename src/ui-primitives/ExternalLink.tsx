import { fs } from '@/adapters'
import { toast } from 'sonner'
import { cn } from './util'

interface Props {
  /** URL to open in the browser, or a file-system path to reveal in the OS file manager. */
  target: string
  /** Visible label (defaults to `target`). */
  children?: React.ReactNode
  mono?: boolean
  className?: string
  title?: string
}

/**
 * A clickable text link that opens its target with the system default handler:
 *   - URLs (http/https) → default browser
 *   - File-system paths → default file manager (directory) or default app (file)
 *
 * Uses the orange accent from the design system to mark interactive text.
 */
export function ExternalLink({ target, children, mono, className, title }: Props) {
  const onClick = async () => {
    try {
      await fs.openExternal(target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? target}
      className={cn(
        'text-sm text-left break-all text-orange-400 hover:text-orange-300 hover:underline underline-offset-2',
        mono && 'font-mono',
        className,
      )}
    >
      {children ?? target}
    </button>
  )
}
