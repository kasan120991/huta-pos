/**
 * Parse results.
 *
 * Parsers return this instead of throwing because the register re-parses the weight and
 * amount fields on every keystroke — `try`/`catch` inside a Vue computed is miserable,
 * and the failure `code` is what decides which message the terminal shows.
 *
 * Constructors (`cents`, `baseQuantity`, …) still throw: reaching one with a bad value is
 * a programmer error, not user input.
 */

export type ParseFailureCode =
  | 'EMPTY'
  | 'MALFORMED'
  | 'TOO_PRECISE'
  | 'OUT_OF_RANGE'
  | 'NEGATIVE'

export interface ParseSuccess<T> {
  readonly ok: true
  readonly value: T
}

export interface ParseFailure {
  readonly ok: false
  readonly code: ParseFailureCode
  /** Message intended to be shown to staff at the register, not a developer string. */
  readonly message: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

export const ok = <T>(value: T): ParseSuccess<T> => ({ ok: true, value })

export const fail = (code: ParseFailureCode, message: string): ParseFailure => ({
  ok: false,
  code,
  message,
})

/** Escape hatch for tests, seed scripts, and anywhere a failure is genuinely impossible. */
export function unwrapOrThrow<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.value
}
