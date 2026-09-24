'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const TABS = [
  { value: 'renewals', label: 'Renewals' },
  { value: 'orders', label: 'Orders' },
  { value: 'activity', label: 'Activity' },
] as const

/** The tab strip only: every panel is rendered on the server and handed in. */
export function ComingUpTabs({
  panels,
}: {
  panels: Record<(typeof TABS)[number]['value'], React.ReactNode>
}) {
  return (
    <Tabs defaultValue="renewals" className="mt-4 gap-3">
      <TabsList className="h-auto flex-wrap justify-start gap-1.5 bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-auto">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="h-9 flex-none rounded-full border-border bg-background px-3.5 text-sm font-normal text-muted-foreground shadow-none hover:text-foreground data-[state=active]:border-brand data-[state=active]:bg-brand data-[state=active]:text-brand-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-brand dark:data-[state=active]:bg-brand dark:data-[state=active]:text-brand-foreground"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {panels[tab.value]}
        </TabsContent>
      ))}
    </Tabs>
  )
}
