import type { ReactNode } from 'react'

interface Props {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}

export function Inspector({ title, subtitle, actions, children }: Props) {
  return (
    <div className="flex flex-col h-full">
      {(title || actions) && (
        <header className="@container px-5 py-3 border-b border-[var(--color-line)] shrink-0">
          <div className="flex flex-col items-start gap-2 @[560px]:flex-row @[560px]:items-center @[560px]:justify-between">
            <div className="min-w-0 max-w-full">
              {title && <div className="text-[14px] truncate t-hi">{title}</div>}
              {subtitle && (
                <div className="text-[11px] truncate" style={{ color: 'var(--color-ghost)' }}>{subtitle}</div>
              )}
            </div>
            {actions && (
              <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>
            )}
          </div>
        </header>
      )}
      <div className="px-5 pt-3 pb-1 text-[10px] tracking-[0.2em] t-ghost shrink-0">// CONTENT</div>
      <div className="flex-1 overflow-auto px-5 pb-4 space-y-4">{children}</div>
    </div>
  )
}
