import {
  API_ERROR_NAMES,
  API_OPERATIONS,
  EMAIL_STATUSES,
  jsonSchemaOf,
  sendEmailSchema,
} from '@dr/shared/mail'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DocsFrame, DocsNav, StubNotice } from '../docs/docs-frame'
import { ERROR_DOCS } from '../docs/errors'
import { DOCS_PAGES, docsPage } from '../docs/pages'
import { ApiReference } from '../docs/reference'
import {
  API_KEY_ENV,
  curlSendExample,
  nodeExample,
  phpExample,
  pythonExample,
  readBackExample,
  SEND_SAMPLES,
} from '../docs/samples'
import { fieldRows, typeWords } from '../docs/schema-rows'
import { STATUS_DOCS } from '../docs/statuses'

/**
 * The docs (MAIL-SPEC §6 "Docs"): the reference is the API's own schemas,
 * the samples send a body the API accepts, every error name and status has
 * words, and the stubs say they are stubs (N9b).
 */

const pathname = vi.hoisted(() => ({ current: '/docs/api' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }))

describe('the field tables', () => {
  it('say a type in words', () => {
    expect(typeWords({ type: 'string', format: 'uuid' })).toBe('string (uuid)')
    expect(typeWords({ type: 'string', format: 'date-time' })).toBe(
      'string (ISO 8601 date and time)',
    )
    expect(typeWords({ type: 'string', format: 'email' })).toBe('string (email address)')
    expect(
      typeWords({ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }),
    ).toBe('string or array of strings')
    expect(typeWords({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string or null')
    expect(typeWords({ type: ['integer', 'null'] })).toBe('integer or null')
    expect(typeWords({ enum: ['full', 'sending'] })).toBe('one of: full, sending')
    expect(typeWords({ type: 'array', items: { enum: ['a'] } })).toBe('array of values one of: a')
    expect(typeWords({ const: 'email' })).toBe('"email"')
    expect(typeWords({ type: 'object', additionalProperties: { type: 'string' } })).toBe(
      'object of strings',
    )
    expect(typeWords({ type: 'object' })).toBe('object')
    expect(typeWords({ type: 'array' })).toBe('array')
    expect(typeWords({})).toBe('any')
    expect(typeWords({ type: 'boolean' })).toBe('boolean')
  })

  it('open objects and arrays of objects into their own fields', () => {
    const rows = fieldRows(jsonSchemaOf(sendEmailSchema, 'input'))
    const names = rows.map((row) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'from',
        'to',
        'scheduled_at',
        'attachments[].filename',
        'tags[].value',
      ]),
    )
    expect(rows.find((row) => row.name === 'from')).toMatchObject({ required: true })
    expect(rows.find((row) => row.name === 'html')).toMatchObject({ required: false })
    expect(rows.find((row) => row.name === 'to')?.type).toBe('string or array of strings')
    expect(fieldRows({ type: 'string' })).toEqual([])
    expect(fieldRows(jsonSchemaOf(z.object({ a: z.string().nullable() }), 'output'))).toEqual([
      { name: 'a', type: 'string or null', required: true, description: '' },
    ])
  })
})

describe('the samples', () => {
  it('send a body the API accepts, read the key from the environment, never a key itself', () => {
    const body = JSON.parse(
      (/-d '([\s\S]+)'$/.exec(curlSendExample())?.[1] ?? '').replace(/\n {2}/g, '\n'),
    )
    expect(sendEmailSchema.safeParse(body).success).toBe(true)
    for (const sample of SEND_SAMPLES) {
      const code = sample.code()
      expect(code, sample.id).toContain('https://emails.mydomainshub.com/api/v1/emails')
      expect(code, sample.id).toContain(API_KEY_ENV)
      expect(code, sample.id).toContain('Idempotency-Key')
      expect(code, sample.id).toContain('receipts@acme.ng')
      expect(code, sample.id).not.toMatch(/mdh_live_[A-Za-z0-9]{4}/)
    }
    expect(nodeExample()).toContain("method: 'POST'")
    expect(pythonExample()).toContain('urllib.request.urlopen')
    expect(phpExample()).toContain("'to' => ['ada@example.com']")
    expect(readBackExample()).toContain('/emails/')
  })
})

describe('the words the docs keep', () => {
  it('cover every error name and every status there is', () => {
    expect(Object.keys(ERROR_DOCS).sort()).toEqual([...API_ERROR_NAMES].sort())
    expect(Object.keys(STATUS_DOCS).sort()).toEqual([...EMAIL_STATUSES].sort())
  })

  it('list each page once, in order, and find one by its slug', () => {
    expect(new Set(DOCS_PAGES.map((page) => page.href)).size).toBe(DOCS_PAGES.length)
    expect(docsPage('quickstart').href).toBe('/docs/quickstart')
    expect(() => docsPage('nope')).toThrow()
    expect(DOCS_PAGES.filter((page) => page.stub).map((page) => page.slug)).toEqual(['domains'])
  })
})

describe('the reference', () => {
  it('has a section for every operation, with its fields, answer and errors', () => {
    render(<ApiReference />)
    for (const operation of API_OPERATIONS) {
      const section = document.getElementById(operation.id) as HTMLElement
      expect(section, operation.id).not.toBeNull()
      expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent(
        `${operation.method}${operation.path}`,
      )
    }
    const send = document.getElementById('sendEmail') as HTMLElement
    expect(within(send).getByRole('region', { name: 'POST /emails: body' })).toHaveTextContent(
      'scheduled_at',
    )
    expect(within(send).getByRole('region', { name: 'POST /emails: headers' })).toHaveTextContent(
      'Idempotency-Key',
    )
    expect(within(send).getByRole('region', { name: 'POST /emails: errors' })).toHaveTextContent(
      'quota_exceeded',
    )
    const batch = document.getElementById('sendBatch') as HTMLElement
    expect(batch).toHaveTextContent('A JSON array of 1 to 100 emails')
    const list = document.getElementById('listEmails') as HTMLElement
    expect(
      within(list).getByRole('region', { name: 'GET /emails: query parameters' }),
    ).toHaveTextContent('cursor')
    const one = document.getElementById('getEmail') as HTMLElement
    expect(within(one).getByRole('region', { name: 'GET /emails/{id}: path' })).toBeInTheDocument()
    expect(document.getElementById('openApi')).toHaveTextContent('OpenAPI 3.1 document')
    expect(screen.getByRole('navigation', { name: 'Endpoints' })).toBeInTheDocument()
  })
})

describe('the docs frame', () => {
  it('marks the current page in words and weight, and labels the pages still to come', () => {
    pathname.current = '/docs/api'
    render(<DocsNav />)
    const nav = screen.getByRole('navigation', { name: 'Docs' })
    expect(within(nav).getByRole('link', { name: 'API reference' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('link', { name: 'Webhooks' })).toHaveAttribute(
      'href',
      '/docs/webhooks',
    )
    expect(within(nav).getByRole('link', { name: /^Domains and DNS\s*Soon$/ })).toHaveAttribute(
      'href',
      '/docs/domains',
    )
  })

  it('puts the page’s title on the panel and its content beside the docs’ navigation', () => {
    pathname.current = '/docs/errors'
    render(
      <DocsFrame slug="errors" intro={<p>Intro words</p>}>
        <StubNotice>
          <p>Not here yet</p>
        </StubNotice>
      </DocsFrame>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Errors' })).toBeInTheDocument()
    expect(screen.getByText('Intro words')).toBeInTheDocument()
    expect(screen.getByRole('article')).toHaveTextContent('Not here yet')
    expect(document.querySelector('[data-stub="true"]')).not.toBeNull()
  })
})
