import { z } from 'zod'
import { batchSchema, EMAIL_LIMITS, sendEmailSchema } from './api'
import { API_ERROR_NAMES, type ApiErrorName, apiErrorSchema } from './errors'
import {
  apiKeyListSchema,
  apiKeySchema,
  batchQueuedSchema,
  createApiKeySchema,
  createDomainSchema,
  createdApiKeySchema,
  deletedDomainSchema,
  domainListSchema,
  domainSchema,
  emailChangedSchema,
  emailListSchema,
  emailSchema,
  listEmailsQuerySchema,
  queuedSchema,
  rescheduleSchema,
  revokedApiKeySchema,
} from './resources'

/**
 * The v1 API described once (MAIL-SPEC §6): every operation with its
 * schemas — the same Zod schemas the handlers validate with — from which
 * the OpenAPI 3.1 document (`/api/v1/openapi.json`) and the docs' reference
 * are both generated. An operation that is not listed here does not exist;
 * one listed here has a route (a test holds the two together).
 */

export type ApiAccess = 'sending' | 'full' | 'none'

export type ErrorCase = { status: number; names: readonly ApiErrorName[]; when: string }

export type ApiOperation = {
  id: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  summary: string
  description: string
  access: ApiAccess
  /** A component name from `API_SCHEMAS`. */
  body?: SchemaName
  query?: z.ZodObject
  pathId?: string
  idempotent?: boolean
  response: SchemaName
  errors: readonly ErrorCase[]
}

/** The named schemas, as they appear under `components.schemas`. */
export const API_SCHEMAS = {
  SendEmail: { schema: sendEmailSchema, io: 'input' },
  BatchSendEmail: { schema: batchSchema, io: 'input' },
  Reschedule: { schema: rescheduleSchema, io: 'input' },
  CreateApiKey: { schema: createApiKeySchema, io: 'input' },
  Queued: { schema: queuedSchema, io: 'output' },
  BatchQueued: { schema: batchQueuedSchema, io: 'output' },
  Email: { schema: emailSchema, io: 'output' },
  EmailList: { schema: emailListSchema, io: 'output' },
  EmailChanged: { schema: emailChangedSchema, io: 'output' },
  ApiKey: { schema: apiKeySchema, io: 'output' },
  ApiKeyList: { schema: apiKeyListSchema, io: 'output' },
  CreatedApiKey: { schema: createdApiKeySchema, io: 'output' },
  RevokedApiKey: { schema: revokedApiKeySchema, io: 'output' },
  CreateDomain: { schema: createDomainSchema, io: 'input' },
  Domain: { schema: domainSchema, io: 'output' },
  DomainList: { schema: domainListSchema, io: 'output' },
  DeletedDomain: { schema: deletedDomainSchema, io: 'output' },
  Error: { schema: apiErrorSchema, io: 'output' },
  OpenApi: { schema: z.looseObject({ openapi: z.literal('3.1.0') }), io: 'output' },
} as const satisfies Record<string, { schema: z.ZodType; io: 'input' | 'output' }>

export type SchemaName = keyof typeof API_SCHEMAS

const KEY_ERRORS: readonly ErrorCase[] = [
  {
    status: 401,
    names: ['unauthorized'],
    when: 'The API key is missing, wrong or revoked.',
  },
  {
    status: 429,
    names: ['rate_limited'],
    when: 'More than 10 requests a second with this key (bursts of 20). Wait for retry-after.',
  },
  { status: 500, names: ['internal_error'], when: 'Something failed on our side.' },
]

const FULL_ONLY: ErrorCase = {
  status: 403,
  names: ['forbidden'],
  when: 'A sending key was used: this takes a full-access key.',
}

const NOT_FOUND: ErrorCase = {
  status: 404,
  names: ['not_found'],
  when: 'No email with that id belongs to this account.',
}

const NOT_PENDING: ErrorCase = {
  status: 409,
  names: ['validation_error'],
  when: 'The email has already left the queue (or is being sent).',
}

const DOMAIN_FULL_ONLY: ErrorCase = {
  status: 403,
  names: ['forbidden'],
  when: 'A sending key was used: managing domains takes a full-access key.',
}

const DOMAIN_NOT_FOUND: ErrorCase = {
  status: 404,
  names: ['not_found'],
  when: 'No domain with that id belongs to this account.',
}

const SEND_ERRORS: readonly ErrorCase[] = [
  {
    status: 403,
    names: ['forbidden', 'domain_not_verified', 'account_paused'],
    when: 'The from domain is not verified on this account, the key is limited to another domain, the sandbox refuses the recipient, or sending is paused.',
  },
  {
    status: 409,
    names: ['validation_error'],
    when: 'The Idempotency-Key was used for a different request in the last 24 hours.',
  },
  { status: 413, names: ['validation_error'], when: 'The request is larger than 4 MB.' },
  {
    status: 422,
    names: ['validation_error'],
    when: 'The body is not valid (the message says where), or the content check refuses it: a From that imitates a bank, a payments company or a government body, a link through a URL shortener, or a program attached.',
  },
  {
    status: 429,
    names: ['rate_limited', 'quota_exceeded'],
    when: 'Too many requests with this key, or a daily or monthly cap is reached. Wait for retry-after.',
  },
]

export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    id: 'sendEmail',
    method: 'POST',
    path: '/emails',
    summary: 'Send an email',
    description:
      'Queues one email and answers its id. Our worker then sends it — at `scheduled_at`, if you gave one. The answer means queued, not delivered: read the status back, or watch the log.',
    access: 'sending',
    body: 'SendEmail',
    idempotent: true,
    response: 'Queued',
    errors: [...KEY_ERRORS, ...SEND_ERRORS],
  },
  {
    id: 'sendBatch',
    method: 'POST',
    path: '/emails/batch',
    summary: 'Send up to 100 emails',
    description: `A JSON array of 1 to ${EMAIL_LIMITS.maxBatch} emails, each shaped as for POST /emails. Every one is checked first, and either all are queued or none is: a refusal names the first email refused as \`emails[n]\`.`,
    access: 'sending',
    body: 'BatchSendEmail',
    idempotent: true,
    response: 'BatchQueued',
    errors: [...KEY_ERRORS, ...SEND_ERRORS],
  },
  {
    id: 'listEmails',
    method: 'GET',
    path: '/emails',
    summary: 'List emails',
    description:
      'The account’s emails, newest first, a page at a time. Filters combine: every one given must match.',
    access: 'full',
    query: listEmailsQuerySchema,
    response: 'EmailList',
    errors: [
      ...KEY_ERRORS,
      FULL_ONLY,
      { status: 422, names: ['validation_error'], when: 'A filter or the cursor is not valid.' },
    ],
  },
  {
    id: 'getEmail',
    method: 'GET',
    path: '/emails/{id}',
    summary: 'Read an email',
    description:
      'Its status, its times and the last event Amazon SES reported. Never its body: bodies are kept 72 hours after sending, for the dashboard only.',
    access: 'full',
    pathId: 'The email’s id, as POST /emails answered it.',
    response: 'Email',
    errors: [...KEY_ERRORS, FULL_ONLY, NOT_FOUND],
  },
  {
    id: 'rescheduleEmail',
    method: 'PATCH',
    path: '/emails/{id}',
    summary: 'Reschedule an email',
    description:
      'Moves an email that is still waiting in the queue to another time. It counts against your caps on the day it was first queued.',
    access: 'full',
    pathId: 'The email’s id.',
    body: 'Reschedule',
    response: 'EmailChanged',
    errors: [
      ...KEY_ERRORS,
      FULL_ONLY,
      NOT_FOUND,
      NOT_PENDING,
      {
        status: 422,
        names: ['validation_error'],
        when: 'scheduled_at is missing, malformed or too far ahead.',
      },
    ],
  },
  {
    id: 'cancelEmail',
    method: 'POST',
    path: '/emails/{id}/cancel',
    summary: 'Cancel an email',
    description:
      'Cancels an email that is still waiting in the queue — scheduled, or not yet picked up. Its recipients are given back to your caps, and its body is deleted. Cancelling a canceled email answers the same again.',
    access: 'full',
    pathId: 'The email’s id.',
    response: 'EmailChanged',
    errors: [...KEY_ERRORS, FULL_ONLY, NOT_FOUND, NOT_PENDING],
  },
  {
    id: 'listApiKeys',
    method: 'GET',
    path: '/api-keys',
    summary: 'List API keys',
    description: 'The account’s keys that are not revoked, newest first. Never a key itself.',
    access: 'full',
    response: 'ApiKeyList',
    errors: [...KEY_ERRORS, FULL_ONLY],
  },
  {
    id: 'createApiKey',
    method: 'POST',
    path: '/api-keys',
    summary: 'Create an API key',
    description:
      'Makes a key and answers it once: we keep only a hash, so store it now. The account’s log records it, with the key that made it.',
    access: 'full',
    body: 'CreateApiKey',
    response: 'CreatedApiKey',
    errors: [
      ...KEY_ERRORS,
      {
        status: 403,
        names: ['forbidden'],
        when: 'A sending key was used, or the account is closed.',
      },
      {
        status: 422,
        names: ['validation_error'],
        when: 'The body is not valid; the message says where.',
      },
    ],
  },
  {
    id: 'revokeApiKey',
    method: 'DELETE',
    path: '/api-keys/{id}',
    summary: 'Revoke an API key',
    description:
      'Revokes a key at once: requests with it are refused from now on, and emails it queued that have not left are not sent. Revoking a revoked key answers the same again.',
    access: 'full',
    pathId: 'The key’s id, from GET /api-keys.',
    response: 'RevokedApiKey',
    errors: [
      ...KEY_ERRORS,
      FULL_ONLY,
      { status: 404, names: ['not_found'], when: 'No key with that id belongs to this account.' },
    ],
  },
  {
    id: 'listDomains',
    method: 'GET',
    path: '/domains',
    summary: 'List domains',
    description:
      'The account’s domains, each with its status and, while it is pending, the DNS records to add.',
    access: 'full',
    response: 'DomainList',
    errors: [...KEY_ERRORS, DOMAIN_FULL_ONLY],
  },
  {
    id: 'addDomain',
    method: 'POST',
    path: '/domains',
    summary: 'Add a domain',
    description:
      'Adds a domain to send from and sets it up with Amazon SES. The answer lists the DNS records to add at your DNS host; Amazon SES verifies the domain once it finds them.',
    access: 'full',
    body: 'CreateDomain',
    response: 'Domain',
    errors: [
      ...KEY_ERRORS,
      {
        status: 403,
        names: ['forbidden'],
        when: 'A sending key was used, the plan’s domains are all taken, or the account is closed.',
      },
      {
        status: 409,
        names: ['validation_error'],
        when: 'The domain is already on this account, or in use on another.',
      },
      {
        status: 422,
        names: ['validation_error'],
        when: 'The name is not a domain, or is one of ours.',
      },
    ],
  },
  {
    id: 'getDomain',
    method: 'GET',
    path: '/domains/{id}',
    summary: 'Read a domain',
    description: 'One domain: its status and the DNS records it needs.',
    access: 'full',
    pathId: 'The domain’s id, from GET /domains.',
    response: 'Domain',
    errors: [...KEY_ERRORS, DOMAIN_FULL_ONLY, DOMAIN_NOT_FOUND],
  },
  {
    id: 'verifyDomain',
    method: 'POST',
    path: '/domains/{id}/verify',
    summary: 'Check a domain now',
    description:
      'Asks Amazon SES about the domain now, as the dashboard’s “Check now” does, and answers what it found.',
    access: 'full',
    pathId: 'The domain’s id.',
    response: 'Domain',
    errors: [...KEY_ERRORS, DOMAIN_FULL_ONLY, DOMAIN_NOT_FOUND],
  },
  {
    id: 'removeDomain',
    method: 'DELETE',
    path: '/domains/{id}',
    summary: 'Remove a domain',
    description: 'Removes a domain from the account. Refused while emails from it wait to be sent.',
    access: 'full',
    pathId: 'The domain’s id.',
    response: 'DeletedDomain',
    errors: [
      ...KEY_ERRORS,
      DOMAIN_FULL_ONLY,
      DOMAIN_NOT_FOUND,
      { status: 409, names: ['validation_error'], when: 'Emails from it still wait to be sent.' },
    ],
  },
  {
    id: 'openApi',
    method: 'GET',
    path: '/openapi.json',
    summary: 'This API, described',
    description: 'This document: OpenAPI 3.1, generated from the schemas the API validates with.',
    access: 'none',
    response: 'OpenApi',
    errors: [],
  },
]

/** A Zod schema as JSON Schema 2020-12, without the `$schema` line OpenAPI keeps at the top. */
export function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return rest
}

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` })

const ACCESS_WORDS: Record<ApiAccess, string> = {
  sending: 'Takes a sending or a full-access key.',
  full: 'Takes a full-access key.',
  none: 'Takes no key.',
}

export const accessWords = (access: ApiAccess): string => ACCESS_WORDS[access]

/** The query parameters of an operation, each with its own schema and words. */
export function queryParameters(query: z.ZodObject): {
  name: string
  description: string
  schema: Record<string, unknown>
}[] {
  return Object.entries(query.shape).map(([name, field]) => {
    const { description = '', ...schema } = jsonSchemaOf(field as z.ZodType, 'input')
    return { name, description: String(description), schema }
  })
}

const REQUEST_ID = {
  description: 'This request’s id. Quote it when you write to us about a request.',
  schema: { type: 'string', format: 'uuid' },
}

function operationObject(operation: ApiOperation): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = []
  if (operation.pathId) {
    parameters.push({
      name: 'id',
      in: 'path',
      required: true,
      description: operation.pathId,
      schema: { type: 'string', format: 'uuid' },
    })
  }
  if (operation.query) {
    for (const parameter of queryParameters(operation.query)) {
      parameters.push({ ...parameter, in: 'query', required: false })
    }
  }
  if (operation.idempotent) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Up to 256 printable ASCII characters. The same key with the same body within 24 hours answers the first request’s answer again and queues nothing more; with a different body it is refused (409).',
      schema: { type: 'string', minLength: 1, maxLength: EMAIL_LIMITS.maxIdempotencyKeyChars },
    })
  }

  const responses: Record<string, unknown> = {
    '200': {
      description: 'Done.',
      headers: { 'x-request-id': { $ref: '#/components/headers/RequestId' } },
      content: { 'application/json': { schema: ref(operation.response) } },
    },
  }
  for (const error of operation.errors) {
    const status = String(error.status)
    const existing = responses[status] as { description: string } | undefined
    responses[status] = {
      description: existing ? `${existing.description} Or: ${error.when}` : error.when,
      headers: {
        'x-request-id': { $ref: '#/components/headers/RequestId' },
        ...(error.status === 429
          ? { 'retry-after': { $ref: '#/components/headers/RetryAfter' } }
          : {}),
      },
      content: { 'application/json': { schema: ref('Error') } },
    }
  }

  return {
    operationId: operation.id,
    summary: operation.summary,
    description: `${operation.description} ${ACCESS_WORDS[operation.access]}`,
    ...(operation.access === 'none' ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(operation.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(operation.body) } },
          },
        }
      : {}),
    responses,
  }
}

export type OpenApiDocument = {
  openapi: '3.1.0'
  jsonSchemaDialect: string
  info: { title: string; version: string; description: string }
  servers: { url: string }[]
  security: Record<string, string[]>[]
  paths: Record<string, Record<string, Record<string, unknown>>>
  components: Record<string, Record<string, unknown>>
}

export function buildOpenApi({ serverUrl }: { serverUrl: string }): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {}
  for (const operation of API_OPERATIONS) {
    paths[operation.path] ??= {}
    const item = paths[operation.path] as Record<string, Record<string, unknown>>
    item[operation.method.toLowerCase()] = operationObject(operation)
  }

  const schemas: Record<string, unknown> = {}
  for (const [name, { schema, io }] of Object.entries(API_SCHEMAS)) {
    schemas[name] = jsonSchemaOf(schema, io)
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'MyDomainsHub Mail API',
      version: '1',
      description: `Send transactional email with one HTTP call. JSON in and out. Every error is { "name", "message" } with its status, one of: ${API_ERROR_NAMES.join(', ')}. Every answer carries x-request-id.`,
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Authorization: Bearer mdh_live_… — a key made in the dashboard, or with POST /api-keys.',
        },
      },
      headers: {
        RequestId: REQUEST_ID,
        RetryAfter: {
          description: 'Seconds to wait before trying again.',
          schema: { type: 'integer', minimum: 1 },
        },
      },
      schemas,
    },
  }
}
