import { cn } from './util'

/**
 * Semantic colors aligned with the design system:
 *   green  → activation / enabled / success
 *   grey   → inactive / disabled
 *   orange → emphasis / dirty / attention
 *   red    → error / destructive
 *   amber  → warning
 */
export type DotColor = 'green' | 'grey' | 'orange' | 'red' | 'amber'

const COLOR_CLASS: Record<DotColor, string> = {
  green: 'bg-emerald-400',
  grey: 'bg-zinc-600',
  orange: 'bg-orange-400',
  red: 'bg-red-400',
  amber: 'bg-amber-400',
}

interface Props {
  color: DotColor
  /** Tailwind size classes (defaults to a 6px dot). */
  size?: string
  /** Tooltip text. */
  title?: string
  className?: string
}

export function ColorDot({ color, size = 'w-1.5 h-1.5', title, className }: Props) {
  return (
    <span
      title={title}
      className={cn('inline-block rounded-full shrink-0', size, COLOR_CLASS[color], className)}
    />
  )
}
