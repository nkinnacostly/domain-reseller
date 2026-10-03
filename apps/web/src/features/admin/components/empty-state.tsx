import { Inbox } from 'lucide-react'
import { PANEL } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/** Nothing to show, said plainly, with what to do next when there is something. */
export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string
  body?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(PANEL, 'flex flex-col items-center gap-2 p-8 text-center', className)}>
      <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium text-foreground">{title}</p>
      {body ? <div className="max-w-md text-sm text-muted-foreground">{body}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
