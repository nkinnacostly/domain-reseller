/**
 * Standard base64 (RFC 4648 §4, with padding), written out because
 * `packages/shared` compiles without DOM or Node types — no `btoa`, no
 * `Buffer`. Used for MIME parts, SES raw messages and webhook signatures.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]))

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += ALPHABET[(triple >> 18) & 63]
    out += ALPHABET[(triple >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[triple & 63] : '='
  }
  return out
}

/** Whitespace is ignored (MIME wraps lines); anything else off the alphabet is refused. */
export function fromBase64(input: string): Uint8Array | null {
  const text = input.replace(/\s+/g, '')
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - padding)
  let at = 0
  for (let i = 0; i < text.length; i += 4) {
    const values = [0, 1, 2, 3].map((k) => LOOKUP.get(text[i + k] ?? '=') ?? 0)
    const triple =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0)
    for (const shift of [16, 8, 0]) {
      if (at < out.length) out[at++] = (triple >> shift) & 255
    }
  }
  return out
}

/** The decoded size of a base64 text, without decoding it. */
export function base64ByteLength(input: string): number {
  const text = input.replace(/\s+/g, '')
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding)
}

/** Base64 in lines of 76, as MIME wants it (RFC 2045 §6.8). */
export function wrapBase64(base64: string, width = 76): string {
  const text = base64.replace(/\s+/g, '')
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines.join('\r\n')
}
