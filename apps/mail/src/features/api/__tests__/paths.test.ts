import { API_OPERATIONS } from '@dr/shared/mail'
import { describe, expect, it, vi } from 'vitest'
import * as notFound from '@/app/api/v1/[...path]/route'
import * as key from '@/app/api/v1/api-keys/[id]/route'
import * as keys from '@/app/api/v1/api-keys/route'
import * as domain from '@/app/api/v1/domains/[id]/route'
import * as domainCheck from '@/app/api/v1/domains/[id]/verify/route'
import * as domains from '@/app/api/v1/domains/route'
import * as cancel from '@/app/api/v1/emails/[id]/cancel/route'
import * as email from '@/app/api/v1/emails/[id]/route'
import * as batch from '@/app/api/v1/emails/batch/route'
import * as emails from '@/app/api/v1/emails/route'
import * as openapi from '@/app/api/v1/openapi.json/route'

/**
 * Every path of the v1 API (MAIL-SPEC §6): each operation the OpenAPI
 * document lists has a route, every method a path does not take answers in
 * the API's shape, and an unknown path is the API's JSON 404.
 */

vi.mock('next/server', () => ({ connection: async () => undefined }))

/** Every route the document lists; each answers the methods it does not take itself. */
const ROUTES: Record<string, Record<string, unknown>> = {
  '/emails': emails,
  '/emails/batch': batch,
  '/emails/{id}': email,
  '/emails/{id}/cancel': cancel,
  '/api-keys': keys,
  '/api-keys/{id}': key,
  '/openapi.json': openapi,
  '/domains': domains,
  '/domains/{id}': domain,
  '/domains/{id}/verify': domainCheck,
}

const NOT_FOUND = {
  GET: notFound.GET,
  POST: notFound.POST,
  PATCH: notFound.PATCH,
  PUT: notFound.PUT,
  DELETE: notFound.DELETE,
}

const call = (handler: unknown, path: string, method: string) =>
  (handler as (request: Request, context: unknown) => Promise<Response>)(
    new Request(`http://localhost:3001/api/v1${path}`, { method }),
    { params: Promise.resolve({ id: 'x' }) },
  )

describe('the v1 paths', () => {
  it('has a route for every operation the document lists', () => {
    for (const operation of API_OPERATIONS) {
      expect(ROUTES[operation.path], operation.path).toBeDefined()
      expect(
        typeof ROUTES[operation.path]?.[operation.method],
        `${operation.method} ${operation.path}`,
      ).toBe('function')
    }
  })

  it('answers a method a path does not take with a JSON 405, its allow header and x-request-id', async () => {
    for (const [path, route] of Object.entries(ROUTES)) {
      const listed = API_OPERATIONS.filter((op) => op.path === path).map((op) => op.method)
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].filter(
        (m) => !listed.includes(m as never),
      )) {
        expect(typeof route[method], `${method} ${path} is answered by this API`).toBe('function')
        const response = await call(route[method], path, method)
        expect(response.status, `${method} ${path}`).toBe(405)
        expect(response.headers.get('allow')?.split(', ').sort()).toEqual([...listed].sort())
        expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
        expect(await response.json()).toMatchObject({ name: 'not_found' })
      }
    }
  })

  it('answers an unknown path with the API’s JSON 404', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const response = await NOT_FOUND[method]()
      expect(response.status).toBe(404)
      expect(response.headers.get('x-request-id')).toBeTruthy()
      expect(await response.json()).toEqual({
        name: 'not_found',
        message: expect.stringContaining('/docs/api'),
        statusCode: 404,
      })
    }
  })

  it('serves the OpenAPI document without a key, from this site’s API base', async () => {
    const response = await openapi.GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    const doc = await response.json()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers).toEqual([{ url: 'http://localhost:3001/api/v1' }])
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(Object.keys(ROUTES)))
  })
})
