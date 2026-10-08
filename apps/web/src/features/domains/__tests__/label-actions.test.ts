import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { createLabel, deleteLabel, setDomainLabel, updateLabel } = await import('../actions/labels')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const LABEL_ID = '00000000-0000-4000-8000-0000000000aa'
const ACME = { id: LABEL_ID, name: 'Acme', color: 'blue' }

type Answer = { data?: unknown; error?: { code?: string; message?: string } | null }
type Call = { table: string; op: string; args: unknown[] }

let answers: Record<string, Answer>
let calls: Call[]

/**
 * The signed-in client (RLS): each table and operation answers what the
 * test says, and every write is recorded. Labels are written as the user —
 * the secret key is never used here.
 */
function signedIn() {
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      /** A real promise for this table and operation, with the query methods chained on. */
      const query = (op: string): Record<string, unknown> => {
        const result = answers[`${table}.${op}`] ?? { data: null, error: null }
        const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
        for (const method of ['insert', 'update', 'delete']) {
          node[method] = (...args: unknown[]) => {
            calls.push({ table, op: method, args })
            return query(method)
          }
        }
        for (const method of ['select', 'eq']) node[method] = () => node
        node.single = async () => result
        node.maybeSingle = async () => result
        return node
      }
      return query('select')
    },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  answers = {
    'domain_labels.insert': { data: ACME, error: null },
    'domain_labels.update': { data: { ...ACME, name: 'Acme Ltd', color: 'green' }, error: null },
    'domain_labels.delete': { data: [{ id: LABEL_ID }], error: null },
    'domains.select': { data: { id: DOMAIN_ID, domain_name: 'getpaid.com' }, error: null },
    'domain_label_links.insert': { error: null },
    'domain_label_links.delete': { error: null },
  }
  signedIn()
})

describe('createLabel (FR-P3)', () => {
  it('names the duplicate the database refused', async () => {
    answers['domain_labels.insert'] = { data: null, error: { code: '23505' } }
    const result = await createLabel({ name: 'Acme', color: 'blue' })
    expect(result?.data).toEqual({ error: 'You already have a label called “Acme”.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('says the account is at its limit', async () => {
    answers['domain_labels.insert'] = { data: null, error: { code: '23514' } }
    expect((await createLabel({ name: 'One more', color: 'red' }))?.data).toEqual({
      error: 'An account can have up to 50 labels.',
    })
  })

  it('asks to try again when the write failed for another reason', async () => {
    answers['domain_labels.insert'] = { data: null, error: { code: '08006' } }
    expect((await createLabel({ name: 'Acme', color: 'blue' }))?.data).toEqual({
      error: 'That label could not be saved. Please try again.',
    })
  })

  it('refuses a name the schema does not allow, before any write', async () => {
    const result = await createLabel({ name: 'x'.repeat(31), color: 'blue' })
    expect(result?.validationErrors).toBeDefined()
    expect(calls).toEqual([])
  })

  it('makes no label for a domain that is not the account’s', async () => {
    answers['domains.select'] = { data: null }
    const result = await createLabel({ name: 'Acme', color: 'blue', domainId: DOMAIN_ID })
    expect(result?.data).toEqual({ error: 'That domain is not on your account.' })
    expect(calls).toEqual([])
  })

  it('adds the label as the signed-in user, trimmed', async () => {
    const result = await createLabel({ name: '  Acme  ', color: 'blue' })
    expect(result?.data).toEqual({ ok: true, label: ACME })
    expect(calls).toEqual([
      {
        table: 'domain_labels',
        op: 'insert',
        args: [{ user_id: 'user-1', name: 'Acme', color: 'blue' }],
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings/labels')
    expect(revalidatePath).toHaveBeenCalledWith('/app/domains')
  })

  it('puts a label made from a domain’s page straight onto that domain', async () => {
    const result = await createLabel({ name: 'Acme', color: 'blue', domainId: DOMAIN_ID })
    expect(result?.data).toEqual({ ok: true, label: ACME })
    expect(calls).toContainEqual({
      table: 'domain_label_links',
      op: 'insert',
      args: [{ label_id: LABEL_ID, domain_id: DOMAIN_ID }],
    })
    expect(revalidatePath).toHaveBeenCalledWith('/app/domains/getpaid.com')
  })

  it('says so when the new label could not go onto the domain', async () => {
    answers['domain_label_links.insert'] = { error: { code: '08006' } }
    expect((await createLabel({ name: 'Acme', color: 'blue', domainId: DOMAIN_ID }))?.data).toEqual(
      { error: 'That label could not be added. Please try again.' },
    )
  })
})

describe('updateLabel', () => {
  it('names a clash with another label', async () => {
    answers['domain_labels.update'] = { data: null, error: { code: '23505' } }
    expect((await updateLabel({ id: LABEL_ID, name: 'Banks', color: 'red' }))?.data).toEqual({
      error: 'You already have a label called “Banks”.',
    })
  })

  it('asks to try again when the write failed', async () => {
    answers['domain_labels.update'] = { data: null, error: { code: '08006' } }
    expect((await updateLabel({ id: LABEL_ID, name: 'Banks', color: 'red' }))?.data).toEqual({
      error: 'That label could not be saved. Please try again.',
    })
  })

  it('changes nothing on another account’s label (RLS hides it)', async () => {
    answers['domain_labels.update'] = { data: null, error: null }
    expect((await updateLabel({ id: LABEL_ID, name: 'Mine now', color: 'red' }))?.data).toEqual({
      error: 'That label is not on your account.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('renames and recolours in one go', async () => {
    const result = await updateLabel({ id: LABEL_ID, name: 'Acme Ltd', color: 'green' })
    expect(result?.data).toEqual({
      ok: true,
      label: { id: LABEL_ID, name: 'Acme Ltd', color: 'green' },
    })
    expect(calls).toEqual([
      { table: 'domain_labels', op: 'update', args: [{ name: 'Acme Ltd', color: 'green' }] },
    ])
  })
})

describe('deleteLabel', () => {
  it('asks to try again when the delete failed', async () => {
    answers['domain_labels.delete'] = { data: null, error: { code: '08006' } }
    expect((await deleteLabel({ id: LABEL_ID }))?.data).toEqual({
      error: 'That label could not be deleted. Please try again.',
    })
  })

  it('deletes nothing of another account’s', async () => {
    answers['domain_labels.delete'] = { data: [], error: null }
    expect((await deleteLabel({ id: LABEL_ID }))?.data).toEqual({
      error: 'That label is not on your account.',
    })
  })

  it('deletes the account’s own label', async () => {
    expect((await deleteLabel({ id: LABEL_ID }))?.data).toEqual({ ok: true })
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings/labels')
  })
})

describe('setDomainLabel', () => {
  it('refuses a domain that is not the account’s', async () => {
    answers['domains.select'] = { data: null }
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: true }))?.data,
    ).toEqual({ error: 'That domain is not on your account.' })
    expect(calls).toEqual([])
  })

  it('refuses a label that is not the account’s (RLS)', async () => {
    answers['domain_label_links.insert'] = { error: { code: '42501' } }
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: true }))?.data,
    ).toEqual({ error: 'That label is not on your account.' })
  })

  it('treats a label already on the domain as done', async () => {
    answers['domain_label_links.insert'] = { error: { code: '23505' } }
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: true }))?.data,
    ).toEqual({ ok: true })
  })

  it('puts a label on, and refreshes the domain’s page', async () => {
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: true }))?.data,
    ).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        table: 'domain_label_links',
        op: 'insert',
        args: [{ label_id: LABEL_ID, domain_id: DOMAIN_ID }],
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/app/domains/getpaid.com')
  })

  it('takes a label off', async () => {
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: false }))?.data,
    ).toEqual({ ok: true })
    expect(calls).toEqual([{ table: 'domain_label_links', op: 'delete', args: [] }])
  })

  it('says so when a label could not come off', async () => {
    answers['domain_label_links.delete'] = { error: { code: '08006' } }
    expect(
      (await setDomainLabel({ domainId: DOMAIN_ID, labelId: LABEL_ID, on: false }))?.data,
    ).toEqual({ error: 'That label could not be removed. Please try again.' })
  })
})
