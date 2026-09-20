import { Hono } from 'hono'

export const health = new Hono().get('/', (c) =>
  c.json({ ok: true, data: { status: 'healthy', uptime: process.uptime() } }),
)
