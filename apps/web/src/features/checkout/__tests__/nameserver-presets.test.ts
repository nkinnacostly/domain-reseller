import { describe, expect, it } from 'vitest'
import {
  nameserverRequest,
  type PresetRow,
  perZoneExplanation,
  presetNameservers,
} from '../lib/nameservers'

const VERCEL: PresetRow = {
  id: '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10',
  provider: 'Vercel',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  assigns_per_zone: false,
  verified_at: '2026-09-23T09:00:00Z',
  is_hidden: false,
}
const CLOUDFLARE: PresetRow = {
  ...VERCEL,
  id: '7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  provider: 'Cloudflare',
  nameservers: [],
  assigns_per_zone: true,
}

describe('presetNameservers (FR-C10, FR-D2, N11)', () => {
  it('refuses a preset that does not exist', () => {
    expect(presetNameservers(null)).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('refuses a hidden preset, even when asked for by id', () => {
    expect(presetNameservers({ ...VERCEL, is_hidden: true })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('refuses a preset nobody has verified', () => {
    expect(presetNameservers({ ...VERCEL, verified_at: null })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('refuses a per-zone provider, and says to use the Nameservers tab after registration (FR-D3)', () => {
    const result = presetNameservers(CLOUDFLARE)
    expect(result).toMatchObject({ ok: false, reason: 'per_zone' })
    expect(result.ok ? '' : result.error).toBe(perZoneExplanation('Cloudflare'))
    expect(perZoneExplanation('Cloudflare')).toMatch(/Nameservers tab/)
  })

  it('refuses a stored set that would fail validation, rather than send it to a registry', () => {
    expect(presetNameservers({ ...VERCEL, nameservers: ['ns1.vercel-dns.com'] })).toMatchObject({
      ok: false,
      reason: 'invalid',
      error: expect.stringContaining('Vercel'),
    })
  })

  it('gives the nameservers our table holds for a verified, visible preset', () => {
    expect(presetNameservers(VERCEL)).toEqual({
      ok: true,
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    })
  })
})

describe('nameserverRequest — what the checkout form sends (FR-C10)', () => {
  const presets = [
    { id: VERCEL.id, provider: 'Vercel', assignsPerZone: false },
    { id: CLOUDFLARE.id, provider: 'Cloudflare', assignsPerZone: true },
  ]

  it('asks for a host to be chosen when “pick my host” has none', () => {
    expect(nameserverRequest('preset', '', '', presets)).toEqual({
      ok: false,
      error: 'Choose your host, or pick another option.',
    })
  })

  it('stops a per-zone provider before the order is tried', () => {
    expect(nameserverRequest('preset', CLOUDFLARE.id, '', presets)).toEqual({
      ok: false,
      error: expect.stringMatching(/Cloudflare.+once the domain is registered/),
    })
  })

  it('sends only the preset id for a host — never nameservers typed before switching', () => {
    expect(nameserverRequest('preset', VERCEL.id, 'ns1.other.com ns2.other.com', presets)).toEqual({
      ok: true,
      nameservers: '',
      presetId: VERCEL.id,
    })
  })

  it('sends what was typed only when entering them by hand', () => {
    expect(nameserverRequest('manual', VERCEL.id, 'ns1.host.com', presets)).toEqual({
      ok: true,
      nameservers: 'ns1.host.com',
    })
  })

  it('sends nothing for the registrar’s default, or when no choice was made', () => {
    expect(nameserverRequest('default', VERCEL.id, 'ns1.host.com', presets)).toEqual({
      ok: true,
      nameservers: '',
    })
    expect(nameserverRequest('', '', '', presets)).toEqual({ ok: true, nameservers: '' })
  })
})
