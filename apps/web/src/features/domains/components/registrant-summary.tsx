/** A registrant as the Contacts tab shows it: who, how to reach them, where. */
export function RegistrantSummary({
  registrant,
  className,
}: {
  registrant: Record<string, string | undefined> | null
  className?: string
}) {
  if (!registrant) return <p className={className}>Not recorded.</p>
  const r = registrant
  const address = [
    r.addressLine1,
    r.addressLine2,
    r.city,
    [r.state, r.zipCode].filter(Boolean).join(' '),
    r.country,
  ]
  return (
    <p className={className}>
      {r.firstName} {r.lastName}
      {r.company ? `, ${r.company}` : ''}
      <br />
      <span className="break-all">{r.email}</span> · +{r.phoneCountryCode} {r.phone}
      <br />
      {address.filter(Boolean).join(', ')}
    </p>
  )
}
