import type { MouseEvent, ReactNode } from 'react'
import { toast } from 'sonner'
import { cn } from './util'

interface Props {
  /** The value copied to the clipboard on click. */
  path: string
  /** Visible content. Defaults to `path`. */
  children?: ReactNode
  className?: string
  title?: string
}

export function FilePath({ path, children, className, title }: Props) {
  if (!path) {
    return <span className={cn('font-mono', className)}>{children}</span>
  }
  const onClick = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(path)
      toast.success('Path copied')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copy failed')
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? `Click to copy: ${path}`}
      className={cn(
        'font-mono text-left cursor-pointer transition-colors hover:text-zinc-200',
        className,
      )}
    >
      {children ?? path}
    </button>
  )
}
