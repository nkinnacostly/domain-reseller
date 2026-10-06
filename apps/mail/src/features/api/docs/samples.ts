import { EXAMPLE_EMAIL, EXAMPLE_IDEMPOTENCY_KEY } from '@/features/marketing/lib/send-example'
import { BUSINESS } from '@/lib/business'

/**
 * The quickstart's request in four languages (MAIL-SPEC §6: plain HTTP, no
 * SDK in v1), each built from the one example email — the home page's,
 * which a test holds to the schema the API validates with — so the four can
 * never disagree with each other or with the API. The key is read from the
 * environment (`MDH_API_KEY`), never written into code.
 */

export const API_KEY_ENV = 'MDH_API_KEY'
const SEND_URL = `${BUSINESS.apiBase}/emails`

const indent = (text: string, spaces: number) =>
  text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${' '.repeat(spaces)}${line}`))
    .join('\n')

export function curlSendExample(): string {
  return [
    `curl -X POST ${SEND_URL} \\`,
    `  -H "Authorization: Bearer $${API_KEY_ENV}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -H "Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}" \\`,
    `  -d '${indent(JSON.stringify(EXAMPLE_EMAIL, null, 2), 2)}'`,
  ].join('\n')
}

export function nodeExample(): string {
  return [
    '// Node 18 or later: fetch is built in.',
    `const response = await fetch('${SEND_URL}', {`,
    "  method: 'POST',",
    '  headers: {',
    `    Authorization: \`Bearer \${process.env.${API_KEY_ENV}}\`,`,
    "    'Content-Type': 'application/json',",
    `    'Idempotency-Key': '${EXAMPLE_IDEMPOTENCY_KEY}',`,
    '  },',
    `  body: JSON.stringify(${indent(JSON.stringify(EXAMPLE_EMAIL, null, 2), 2)}),`,
    '})',
    'const result = await response.json()',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample's own template literal, as text
    'if (!response.ok) throw new Error(`${result.name}: ${result.message}`)',
    'console.log(result.id)',
  ].join('\n')
}

const pythonValue = (value: unknown): string =>
  JSON.stringify(value, null, 4)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')

export function pythonExample(): string {
  return [
    '# Python 3, standard library only.',
    'import json',
    'import os',
    'import urllib.error',
    'import urllib.request',
    '',
    `email = ${pythonValue(EXAMPLE_EMAIL)}`,
    '',
    'request = urllib.request.Request(',
    `    "${SEND_URL}",`,
    '    method="POST",',
    '    data=json.dumps(email).encode(),',
    '    headers={',
    `        "Authorization": f"Bearer {os.environ['${API_KEY_ENV}']}",`,
    '        "Content-Type": "application/json",',
    `        "Idempotency-Key": "${EXAMPLE_IDEMPOTENCY_KEY}",`,
    '    },',
    ')',
    'try:',
    '    with urllib.request.urlopen(request) as response:',
    '        print(json.load(response)["id"])',
    'except urllib.error.HTTPError as error:',
    '    problem = json.load(error)',
    "    raise SystemExit(f\"{problem['name']}: {problem['message']}\")",
  ].join('\n')
}

const phpArray = (email: Record<string, unknown>): string => {
  const value = (item: unknown): string =>
    Array.isArray(item)
      ? `[${item.map(value).join(', ')}]`
      : `'${String(item).replace(/'/g, "\\'")}'`
  const lines = Object.entries(email).map(([key, item]) => `        '${key}' => ${value(item)},`)
  return ['[', ...lines, '    ]'].join('\n')
}

export function phpExample(): string {
  return [
    '<?php',
    '// PHP 7.4 or later, with the curl extension.',
    `$ch = curl_init('${SEND_URL}');`,
    'curl_setopt_array($ch, [',
    '    CURLOPT_POST => true,',
    '    CURLOPT_RETURNTRANSFER => true,',
    '    CURLOPT_HTTPHEADER => [',
    `        'Authorization: Bearer ' . getenv('${API_KEY_ENV}'),`,
    "        'Content-Type: application/json',",
    `        'Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}',`,
    '    ],',
    `    CURLOPT_POSTFIELDS => json_encode(${phpArray(EXAMPLE_EMAIL)}),`,
    ']);',
    '$result = json_decode(curl_exec($ch), true);',
    '$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);',
    'curl_close($ch);',
    'if ($status !== 200) {',
    "    throw new Exception($result['name'] . ': ' . $result['message']);",
    '}',
    "echo $result['id'];",
  ].join('\n')
}

export const SEND_SAMPLES = [
  { id: 'curl', label: 'curl', code: curlSendExample },
  { id: 'node', label: 'Node', code: nodeExample },
  { id: 'python', label: 'Python', code: pythonExample },
  { id: 'php', label: 'PHP', code: phpExample },
] as const

/** Reading it back: a full-access key, the id the send answered. */
export function readBackExample(): string {
  return [
    `curl ${BUSINESS.apiBase}/emails/6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d \\`,
    `  -H "Authorization: Bearer $${API_KEY_ENV}"`,
  ].join('\n')
}
