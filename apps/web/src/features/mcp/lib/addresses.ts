/**
 * Which assistant's servers a request came from. Every Claude user reaches
 * /mcp from Anthropic's one published range, and every ChatGPT user from
 * OpenAI's published list, so a per-address limit would make all of them
 * share one person's allowance; each gets its own, larger bucket instead.
 */

/** Anthropic's published outbound range (claude.com connector docs: "if you need to allowlist Anthropic"). */
const ANTHROPIC_V4 = '160.79.104.0/21'

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

/** Whether an IPv4 address (or an IPv4-mapped IPv6 one) falls inside `prefix`, e.g. "104.210.139.192/28". */
export function inIpv4Prefix(address: string | undefined, prefix: string): boolean {
  if (!address) return false
  const [base, bitsText] = prefix.split('/')
  const bits = Number(bitsText)
  const baseValue = ipv4ToInt(base ?? '')
  if (baseValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const value = ipv4ToInt(address.replace(/^::ffff:/i, ''))
  if (value === null) return false
  const size = 2 ** (32 - bits)
  return Math.floor(value / size) === Math.floor(baseValue / size)
}

export function isAnthropicAddress(address: string | undefined): boolean {
  return inIpv4Prefix(address, ANTHROPIC_V4)
}

/** Whether the address is in OpenAI's published ChatGPT connector ranges (fetched by `openAiPrefixes`). */
export function isOpenAiAddress(address: string | undefined, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => inIpv4Prefix(address, prefix))
}
