/**
 * Structured data for search engines and AI assistants (features/seo). A
 * server component: the JSON is in the HTML a crawler reads, no script runs.
 * `<` is escaped so a value can never close the tag early.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON, with `<` escaped — the pattern Next's docs give for JSON-LD.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  )
}
