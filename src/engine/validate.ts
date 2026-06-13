import type { z } from 'zod'

export interface ValidationError {
  path: (string | number)[]
  message: string
}

export interface ValidationResult<T> {
  ok: boolean
  value?: T
  errors: ValidationError[]
}

export const validate = <T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> => {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data, errors: [] }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
  }
}
