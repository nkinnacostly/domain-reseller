/**
 * International domain names (PRD FR-S8).
 *
 * People type names in their own script — `café.com`, `ọmọ.africa` — but the
 * registry, the supplier and our database only speak ASCII. The ASCII form
 * (Punycode, `xn--caf-dma.com`) is what we check, sell and store; the Unicode
 * form is what we show, with the ASCII one beside it.
 *
 * Pure and dependency-free, so the search box, the server and tests all agree.
 * Encoding uses the WHATWG URL parser (UTS #46 mapping, the same one browsers
 * use to resolve the name); decoding is RFC 3492, below.
 */

const ASCII_ONLY = /^\p{ASCII}*$/u
/** The only ASCII a host name may carry; anything else is rejected before parsing. */
const HOST_ASCII = /[a-z0-9.-]/
const ACE_PREFIX = 'xn--'

function hasOtherAscii(input: string): boolean {
  for (const char of input) {
    if (char.charCodeAt(0) < 0x80 && !HOST_ASCII.test(char)) return true
  }
  return false
}

/**
 * A name in any script → its ASCII form, lowercased. Null when it cannot be a
 * host name at all.
 *
 * Plain ASCII never goes through the URL parser: it would turn `123` into the
 * IPv4 address `0.0.0.123`.
 */
export function toAsciiHost(input: string): string | null {
  if (ASCII_ONLY.test(input)) return input.toLowerCase()
  // `@`, `:` and friends mean something to a URL (`café@evil.com` has the host
  // `evil.com`), so they never reach the parser.
  if (hasOtherAscii(input.toLowerCase())) return null
  try {
    return new URL(`http://${input}/`).hostname || null
  } catch {
    return null
  }
}

// RFC 3492 parameters for Punycode.
const BASE = 36
const T_MIN = 1
const T_MAX = 26
const SKEW = 38
const DAMP = 700
const INITIAL_BIAS = 72
const INITIAL_N = 128
const MAX_INT = 0x7fffffff

function adapt(delta: number, points: number, isFirst: boolean): number {
  let d = isFirst ? Math.floor(delta / DAMP) : delta >> 1
  d += Math.floor(d / points)
  let k = 0
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN))
    k += BASE
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW))
}

function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22 // 0–9 → 26–35
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 // a–z → 0–25
  return BASE
}

/** Decodes the part after `xn--`. Throws on anything that is not valid Punycode. */
function decodePunycode(input: string): string {
  const output: number[] = []
  const basicEnd = Math.max(input.lastIndexOf('-'), 0)
  for (let j = 0; j < basicEnd; j += 1) output.push(input.charCodeAt(j))

  let n = INITIAL_N
  let bias = INITIAL_BIAS
  let i = 0
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length; ) {
    const oldI = i
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError('truncated punycode')
      const digit = digitValue(input.charCodeAt(index))
      index += 1
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) {
        throw new RangeError('invalid punycode')
      }
      i += digit * w
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias
      if (digit < t) break
      w *= BASE - t
    }
    const length = output.length + 1
    bias = adapt(i - oldI, length, oldI === 0)
    n += Math.floor(i / length)
    i %= length
    if (n > 0x10ffff) throw new RangeError('invalid punycode')
    output.splice(i, 0, n)
    i += 1
  }
  return String.fromCodePoint(...output)
}

/**
 * One ASCII label → how people read it. Null for an `xn--` label that is not
 * a real encoding (`xn--zz`): it would decode to nothing a registry accepts.
 */
export function toUnicodeLabel(label: string): string | null {
  if (!label.startsWith(ACE_PREFIX)) return label
  try {
    const unicode = decodePunycode(label.slice(ACE_PREFIX.length))
    // Only a label that encodes back to itself is the canonical form.
    if (ASCII_ONLY.test(unicode) || toAsciiHost(unicode) !== label) return null
    return unicode
  } catch {
    return null
  }
}

/** A whole ASCII name → Unicode, label by label. Labels that do not decode stay as they are. */
export function toUnicodeHost(ascii: string): string {
  return ascii
    .split('.')
    .map((label) => toUnicodeLabel(label) ?? label)
    .join('.')
}

export function isIdn(ascii: string): boolean {
  return ascii.split('.').some((label) => label.startsWith(ACE_PREFIX))
}

/**
 * Scripts whose letters pass for one another. A name mixing them — a Latin
 * `paypal` with one Cyrillic `а` — is the classic lookalike (homograph)
 * attack, so FR-S8 refuses it outright. Other mixes, such as Latin with
 * Japanese, are ordinary and allowed (as in UTS #39's restriction levels).
 */
const CONFUSABLE_SCRIPTS = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
] as const

/** The lookalike scripts a label mixes, e.g. `['Latin', 'Cyrillic']`. Null when it does not. */
export function mixedScripts(label: string): string[] | null {
  const found = new Set<string>()
  for (const char of label) {
    for (const [name, pattern] of CONFUSABLE_SCRIPTS) {
      if (pattern.test(char)) found.add(name)
    }
  }
  return found.size > 1 ? [...found] : null
}

/**
 * Cyrillic and Greek letters that are drawn like Latin ones, after the lists
 * browsers use to catch whole-script lookalikes (`аррӏе` for `apple`).
 */
const LATIN_LOOKALIKES: Record<string, string> = {
  а: 'a',
  с: 'c',
  ԁ: 'd',
  е: 'e',
  ҽ: 'e',
  ԍ: 'g',
  һ: 'h',
  і: 'i',
  ј: 'j',
  ӏ: 'l',
  п: 'n',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  г: 'r',
  ѕ: 's',
  ѵ: 'v',
  ԝ: 'w',
  ѡ: 'w',
  х: 'x',
  у: 'y',
  ъ: 'b',
  ь: 'b',
  α: 'a',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
}

/**
 * The Latin name a label can be mistaken for, when every letter in it is a
 * Cyrillic or Greek lookalike of a Latin one (`аррӏе` → `apple`). Null
 * otherwise. Such a name is not refused — it may be a real word in its own
 * script — but people are told what it can pass for.
 */
export function latinLookalike(label: string): { latin: string; script: string } | null {
  let latin = ''
  let script: string | null = null
  for (const char of label) {
    const mapped = LATIN_LOOKALIKES[char]
    if (mapped) {
      latin += mapped
      script = /\p{Script=Greek}/u.test(char) ? 'Greek' : 'Cyrillic'
    } else if (/[0-9-]/.test(char)) {
      latin += char
    } else {
      return null
    }
  }
  return script ? { latin, script } : null
}
