import { isIdn, toUnicodeHost } from '@/features/search/lib/idn'

/**
 * A domain as people read it (PRD FR-S8). Names are stored in their ASCII
 * form — `xn--caf-dma.com` — so an international name is shown in its own
 * script, with the ASCII form beside it: that is what registries, DNS
 * settings and support will quote back. Plain names render as plain text.
 */
export function DomainName({ name, className }: { name: string; className?: string }) {
  const readable = readableForm(name)
  if (!readable) return <>{name}</>
  return (
    <>
      {readable}{' '}
      <span className={className ?? 'font-normal text-xs text-muted-foreground'}>({name})</span>
    </>
  )
}

/** The same, as one string — for labels and lists where markup cannot go. */
export function domainLabel(name: string): string {
  const readable = readableForm(name)
  return readable ? `${readable} (${name})` : name
}

/** The Unicode form, when there is one different from the stored name. */
function readableForm(name: string): string | null {
  if (!isIdn(name)) return null
  const unicode = toUnicodeHost(name)
  return unicode === name ? null : unicode
}
