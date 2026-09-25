import { describe, expect, it } from 'vitest'
import {
  amzDate,
  canonicalRequest,
  hex,
  sha256Hex,
  signingKey,
  signRequest,
  uriEncode,
} from './sigv4'

/**
 * Known answers from AWS's published SigV4 test suite
 * (awslabs/aws-c-auth, tests/aws-signing-test-suite/v4 — the same vectors the
 * SDKs are tested against): AWS's example credentials, us-east-1, service
 * "service", 2015-08-30T12:36:00Z. A signer that only agrees with itself
 * would pass a round trip; these prove it agrees with AWS.
 */
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}
const SCOPE = { region: 'us-east-1', service: 'service' }
const AT = new Date('2015-08-30T12:36:00Z')
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('SigV4 against AWS’s published test suite', () => {
  it('get-vanilla', async () => {
    const signed = await signRequest(
      { method: 'GET', url: 'https://example.amazonaws.com/' },
      CREDENTIALS,
      SCOPE,
      AT,
    )
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    )
    expect(signed.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    )
    expect(signed.signature).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect(signed.headers).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    })
  })

  it('post-vanilla', async () => {
    const signed = await signRequest(
      { method: 'POST', url: 'https://example.amazonaws.com/' },
      CREDENTIALS,
      SCOPE,
      AT,
    )
    expect(signed.stringToSign.split('\n')[3]).toBe(
      '553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87',
    )
    expect(signed.signature).toBe(
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    )
  })

  it('get-vanilla-query-order-key-case: parameters are sorted', async () => {
    const signed = await signRequest(
      { method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' },
      CREDENTIALS,
      SCOPE,
      AT,
    )
    expect(signed.canonicalRequest.split('\n')[2]).toBe('Param1=value1&Param2=value2')
    expect(signed.stringToSign.split('\n')[3]).toBe(
      '816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
    )
    expect(signed.signature).toBe(
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    )
  })

  it('post-x-www-form-urlencoded: a signed body and signed content headers', async () => {
    const body = 'Param1=value1'
    const signed = await signRequest(
      {
        method: 'POST',
        url: 'https://example.amazonaws.com/',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': '13',
          'x-amz-content-sha256': await sha256Hex(body),
        },
        body,
      },
      CREDENTIALS,
      SCOPE,
      AT,
    )
    expect(signed.canonicalRequest).toBe(
      [
        'POST',
        '/',
        '',
        'content-length:13',
        'content-type:application/x-www-form-urlencoded',
        'host:example.amazonaws.com',
        'x-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
        'x-amz-date:20150830T123600Z',
        '',
        'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
        '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
      ].join('\n'),
    )
    expect(signed.stringToSign.split('\n')[3]).toBe(
      'b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb',
    )
    expect(signed.signature).toBe(
      'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b',
    )
  })
})

describe('SigV4 building blocks', () => {
  it('derives the signing key as AWS’s IAM guide shows (20150830, us-east-1, iam)', async () => {
    const key = await signingKey(CREDENTIALS.secretAccessKey, '20150830', {
      region: 'us-east-1',
      service: 'iam',
    })
    expect(hex(key)).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
  })

  it('formats the request time in UTC without separators', () => {
    expect(amzDate(new Date('2026-09-25T08:05:09.123Z'))).toBe('20260925T080509Z')
  })

  it('encodes as SigV4 requires: unreserved characters kept, the rest upper-case hex', () => {
    expect(uriEncode("a-z_A.Z~0 9!'()*/+=é")).toBe('a-z_A.Z~0%209%21%27%28%29%2A%2F%2B%3D%C3%A9')
  })

  it('normalises query parameters: decoded, re-encoded, sorted by name then value', async () => {
    const { text } = await canonicalRequest({
      method: 'get',
      url: 'https://example.amazonaws.com/a%20b/?b=2&a=z&a=y&flag&c=x+y&d=%zz',
      headers: { 'X-Amz-Date': '20150830T123600Z', 'X-Custom': '  two   spaces  ' },
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('GET')
    // Non-S3 services sign the path as sent, encoded once more.
    expect(lines[1]).toBe('/a%2520b/')
    expect(lines[2]).toBe('a=y&a=z&b=2&c=x%20y&d=%25zz&flag=')
    expect(lines).toContain('x-custom:two spaces')
  })

  it('signs the exact body: one changed byte is a different signature', async () => {
    const request = {
      method: 'POST',
      url: 'https://email.eu-west-2.amazonaws.com/v2/x',
      body: '{}',
    }
    const scope = { region: 'eu-west-2', service: 'ses' }
    const a = await signRequest(request, CREDENTIALS, scope, AT)
    const b = await signRequest({ ...request, body: '{ }' }, CREDENTIALS, scope, AT)
    expect(a.signature).not.toBe(b.signature)
    expect(a.headers.authorization).toContain('/20150830/eu-west-2/ses/aws4_request')
    expect(a.headers.authorization).not.toContain(CREDENTIALS.secretAccessKey)
  })
})
