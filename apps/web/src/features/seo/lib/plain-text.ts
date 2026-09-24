import { isValidElement, type ReactNode } from 'react'

/**
 * The words a piece of JSX shows, as one string — for structured data that
 * must repeat an answer written as markup (the help centre's). Children are
 * read first; an element with none is a server component that renders its own
 * text (EmailLink), so it is called. Whitespace collapses as a browser would.
 */
export function plainText(node: ReactNode): string {
  return collect(node).replace(/\s+/g, ' ').trim()
}

function collect(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
    return String(node)
  }
  if (Array.isArray(node)) return node.map(collect).join('')
  if (!isValidElement<{ children?: ReactNode }>(node)) return ''

  const { children } = node.props
  if (children !== undefined) return collect(children)
  if (typeof node.type === 'function') {
    return collect((node.type as (props: unknown) => ReactNode)(node.props))
  }
  return ''
}
