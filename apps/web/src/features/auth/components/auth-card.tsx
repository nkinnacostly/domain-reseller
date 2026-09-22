/** The card every auth page sits in: one job per page, stated in the heading. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-3xl border border-border bg-background p-6 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.3)] sm:p-8">
        <h1 className="text-2xl font-bold tracking-tight text-balance text-foreground">{title}</h1>
        {description ? (
          <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </div>
      {footer ? (
        <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div>
      ) : null}
    </div>
  )
}

export function AuthCardSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-md animate-pulse">
      <div className="h-96 rounded-3xl bg-muted" />
    </div>
  )
}
