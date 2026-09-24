/**
 * "Chrome on macOS" from a user-agent string, for the sessions list (FR-A5).
 *
 * Deliberately small: people need enough to recognise their own devices, not
 * a version number. Order matters, because browsers borrow each other's
 * tokens — Edge and Opera say "Chrome", Chrome says "Safari" — so the most
 * specific names are tried first.
 */

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  // No word boundary before Chrome: headless builds say "HeadlessChrome/".
  [/\bCriOS\/|Chrome\/|\bChromium\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\biPhone\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
]

const first = (userAgent: string, table: [RegExp, string][]) =>
  table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null

export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent?.trim()) return 'Unknown device'
  const browser = first(userAgent, BROWSERS)
  const system = first(userAgent, SYSTEMS)
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'Unknown device'
}
