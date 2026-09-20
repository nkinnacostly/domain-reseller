/** Liveness probe. Uncached by default under Cache Components. */
export function GET() {
  return Response.json({ status: 'healthy', timestamp: new Date().toISOString() })
}
