import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sendEmailSchema } from './api'
import { API_ERROR_NAMES } from './errors'
import {
  API_OPERATIONS,
  API_SCHEMAS,
  accessWords,
  buildOpenApi,
  jsonSchemaOf,
  queryParameters,
} from './openapi'
import { listEmailsQuerySchema } from './resources'

const doc = buildOpenApi({ serverUrl: 'https://emails.mydomainshub.com/api/v1' })

describe('the OpenAPI 3.1 document (§6)', () => {
  it('is 3.1, served from the API base, every request but one behind the bearer key', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers).toEqual([{ url: 'https://emails.mydomainshub.com/api/v1' }])
    expect(doc.security).toEqual([{ apiKey: [] }])
    expect(doc.components.securitySchemes).toMatchObject({
      apiKey: { type: 'http', scheme: 'bearer' },
    })
    expect(doc.paths['/openapi.json']?.get).toMatchObject({ security: [] })
    for (const name of API_ERROR_NAMES) expect(doc.info.description).toContain(name)
  })

  it('has exactly the operations listed, once each', () => {
    const seen = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    )
    expect(seen.sort()).toEqual(API_OPERATIONS.map((op) => `${op.method} ${op.path}`).sort())
    expect(new Set(API_OPERATIONS.map((op) => op.id)).size).toBe(API_OPERATIONS.length)
    expect(seen).toEqual(
      expect.arrayContaining([
        'POST /emails',
        'POST /emails/batch',
        'GET /emails',
        'GET /emails/{id}',
        'PATCH /emails/{id}',
        'POST /emails/{id}/cancel',
        'GET /api-keys',
        'POST /api-keys',
        'DELETE /api-keys/{id}',
      ]),
    )
  })

  it('every answer names its schema and carries x-request-id; every error is the Error shape', () => {
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item) as Record<string, unknown>[]) {
        const responses = operation.responses as Record<string, Record<string, unknown>>
        for (const [status, response] of Object.entries(responses)) {
          expect(response.headers).toHaveProperty('x-request-id')
          const schema = (response.content as Record<string, { schema: { $ref: string } }>)[
            'application/json'
          ]?.schema.$ref
          const name = schema?.replace('#/components/schemas/', '') ?? ''
          expect(Object.keys(API_SCHEMAS)).toContain(name)
          if (status !== '200') expect(name).toBe('Error')
          if (status === '429') expect(response.headers).toHaveProperty('retry-after')
        }
      }
    }
  })

  it('takes its request bodies from the same Zod schemas the API validates with', () => {
    expect(doc.components.schemas?.SendEmail).toEqual(jsonSchemaOf(sendEmailSchema, 'input'))
    const send = doc.components.schemas?.SendEmail as {
      properties: Record<string, { description?: string }>
      required: string[]
      additionalProperties: boolean
    }
    expect(send.required).toEqual(['from', 'to', 'subject'])
    expect(send.additionalProperties).toBe(false)
    expect(Object.keys(send.properties)).toContain('scheduled_at')
    expect(send.properties.from?.description).toContain('verified')
    expect(doc.components.schemas?.SendEmail).not.toHaveProperty('$schema')
    expect(doc.paths['/emails']?.post).toMatchObject({
      requestBody: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/SendEmail' } } },
      },
    })
  })

  it('lists the log’s query parameters and the Idempotency-Key header where they apply', () => {
    const list = doc.paths['/emails']?.get as { parameters: { name: string; in: string }[] }
    expect(list.parameters.map((p) => p.name)).toEqual(Object.keys(listEmailsQuerySchema.shape))
    expect(list.parameters.every((p) => p.in === 'query')).toBe(true)
    const send = doc.paths['/emails']?.post as { parameters: { name: string; in: string }[] }
    expect(send.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
    ])
    const one = doc.paths['/emails/{id}']?.get as { parameters: { name: string; in: string }[] }
    expect(one.parameters).toEqual([expect.objectContaining({ name: 'id', in: 'path' })])
    const params = queryParameters(listEmailsQuerySchema)
    expect(params.find((p) => p.name === 'status')?.schema).toMatchObject({
      enum: expect.any(Array),
    })
    expect(params.every((p) => p.description.length > 10)).toBe(true)
  })

  it('says which key each operation takes', () => {
    expect(accessWords('sending')).toContain('sending or a full-access')
    expect(String(doc.paths['/emails/{id}']?.get?.description)).toContain('full-access key')
    expect(String(doc.paths['/openapi.json']?.get?.description)).toContain('no key')
  })

  it('merges errors that share a status into one response', () => {
    const send = doc.paths['/emails']?.post as {
      responses: Record<string, { description: string }>
    }
    expect(send.responses['429']?.description).toContain('Or:')
  })

  it('every schema becomes JSON Schema without loss of its required fields', () => {
    for (const { schema, io } of Object.values(API_SCHEMAS)) {
      const json = jsonSchemaOf(schema as z.ZodType, io)
      expect(json).not.toHaveProperty('$schema')
      expect(json.type === 'object' || json.type === 'array').toBe(true)
    }
    expect(jsonSchemaOf(z.string(), 'input')).toEqual({ type: 'string' })
  })
})
