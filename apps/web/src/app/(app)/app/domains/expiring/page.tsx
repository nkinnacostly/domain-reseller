import { redirect } from 'next/navigation'

/** PRD §14 route; the expiry view is the portfolio filtered to 30 days (FR-P5). */
export default function ExpiringPage() {
  redirect('/app/domains?within=30')
}
