import { clsx, type ClassValue } from 'clsx'
import { useEffect, useRef } from 'react'

export const cn = (...inputs: ClassValue[]): string => clsx(inputs)

export const useDebounced = <T>(value: T, delay: number, cb: (v: T) => void): void => {
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const t = setTimeout(() => cb(value), delay)
    return () => clearTimeout(t)
  }, [value, delay, cb])
}
