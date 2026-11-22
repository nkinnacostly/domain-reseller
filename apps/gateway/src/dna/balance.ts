/**
 * The supplier balance in an answer to `GetCurrentBalance`, or null when the
 * answer holds none. A blank figure is not a zero: `Number(null)` and
 * `Number('')` are both 0, and on 18 Nov 2026 three snapshots read $0.00
 * between readings of $22.14 with nothing charged — the ledger gap alert
 * stayed open, and a float check would refuse every order (FR-FLOAT-1, N4).
 */
export function balanceUsdFrom(response: {
  OperationResult?: string
  Balance?: unknown
}): number | null {
  if (response.OperationResult !== 'SUCCESS') return null
  const raw = response.Balance
  const balance =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN
  return Number.isFinite(balance) ? balance : null
}
