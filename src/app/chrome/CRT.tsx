import type { ReactNode } from 'react'

/**
 * The Cortex CRT host — wraps the entire app in scanlines, vignette,
 * and noise overlays. Anything rendered as children sits below the effects.
 */
export function CRT({ children }: { children: ReactNode }) {
  return (
    <div className="crt h-full w-full">
      <div className="crt-noise" />
      <div className="absolute inset-0 flex flex-col">{children}</div>
    </div>
  )
}
