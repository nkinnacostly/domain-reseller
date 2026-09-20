export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* <AppSidebar /> + <AppHeader /> */}
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  )
}
