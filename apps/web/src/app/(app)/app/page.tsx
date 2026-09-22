import { redirect } from 'next/navigation'

/** PRD §14: /app lands on the portfolio. */
export default function AppIndex() {
  redirect('/app/domains')
}
