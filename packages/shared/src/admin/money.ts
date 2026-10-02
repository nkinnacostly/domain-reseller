/**
 * USD to integer cents, exactly (N5, D24).
 *
 * The supplier answers in dollars — a number (`15.0`, `3.69`) or a string
 * (`"11.3100"`). Multiplying a float by 100 is how 0.29 becomes 28.999…; the
 * value is read as decimal text instead, and rounded half away from zero at
 * the cent. Anything that is not a finite amount throws: a wrong number is
 * worse than none.
 */
export function usdToCents(value: number | string): number {
  let text: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Not a USD amount')
    // Shortest round-trip text, without an exponent for very small or large values.
    text = /e/i.test(String(value)) ? value.toFixed(10) : String(value)
  } else if (typeof value === 'string') {
    text = value.trim()
  } else {
    throw new Error('Not a USD amount')
  }

  const match = /^([+-])?(\d+)(?:\.(\d*))?$/.exec(text) ?? /^([+-])?()\.(\d+)$/.exec(text)
  if (!match) throw new Error('Not a USD amount')
  const negative = match[1] === '-'
  const whole = match[2] ? BigInt(match[2]) : 0n
  const fraction = match[3] ?? ''
  const twoDigits = BigInt((fraction.slice(0, 2) || '0').padEnd(2, '0'))
  const roundUp = (fraction[2] ?? '0') >= '5'
  const cents = whole * 100n + twoDigits + (roundUp ? 1n : 0n)
  const result = Number(negative ? -cents : cents)
  if (!Number.isSafeInteger(result)) throw new Error('USD amount out of range')
  return result === 0 ? 0 : result
}

/** "$43.38" from cents; "−$11.31" for a debit. Display only. */
export function formatUsdCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Cents must be a whole number')
  const sign = cents < 0 ? '−' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100).toLocaleString('en-US')
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}
