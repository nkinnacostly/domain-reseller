/**
 * Anthropic's published outbound range (claude.com connector docs: "if you
 * need to allowlist Anthropic", 160.79.104.0/21). Every Claude user's
 * requests reach /mcp from it, so a per-address limit would make all of them
 * share one person's allowance; they get their own, larger bucket instead.
 */
const ANTHROPIC_V4 = { base: ipv4ToInt('160.79.104.0'), bits: 21 }

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function isAnthropicAddress(address: string | undefined): boolean {
  if (!address || ANTHROPIC_V4.base === null) return false
  const value = ipv4ToInt(address.replace(/^::ffff:/i, ''))
  if (value === null) return false
  const size = 2 ** (32 - ANTHROPIC_V4.bits)
  return Math.floor(value / size) === Math.floor(ANTHROPIC_V4.base / size)
}
