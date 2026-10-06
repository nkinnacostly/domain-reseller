import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <Container className="py-16 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">This page is not here</h1>
      <p className="mt-3 max-w-xl text-muted-foreground">
        The address may be mistyped, or the page may have moved.
      </p>
      <Button asChild className="mt-6 min-h-11">
        <Link href="/">Go to the home page</Link>
      </Button>
    </Container>
  )
}
