/**
 * The files a customer takes away (FR-SSL-7): the certificate, its chain,
 * and both in one — what Apache, Nginx, cPanel and most hosts ask for —
 * plus, once, the private key we generated for them. Pure.
 */

export type CertificateFile = {
  /** A file name with no `*` in it: the wildcard becomes "wildcard.". */
  name: string
  label: string
  content: string
}

/** example.com → example.com; *.example.com → wildcard.example.com. */
export function fileBase(commonName: string): string {
  return commonName.replace(/^\*\./, 'wildcard.')
}

export function keyFileName(commonName: string): string {
  return `${fileBase(commonName)}.key`
}

export function csrFileName(commonName: string): string {
  return `${fileBase(commonName)}.csr`
}

const tidy = (pem: string) => `${pem.replace(/\r\n?/g, '\n').trim()}\n`

export function certificateFiles(
  commonName: string,
  certificate: string | null,
  chain: string | null,
): CertificateFile[] {
  if (!certificate?.trim()) return []
  const base = fileBase(commonName)
  const files: CertificateFile[] = [
    { name: `${base}.crt`, label: 'Certificate', content: tidy(certificate) },
  ]
  if (chain?.trim()) {
    files.push(
      { name: `${base}.ca-bundle`, label: 'CA chain (intermediates)', content: tidy(chain) },
      {
        name: `${base}-fullchain.pem`,
        label: 'Certificate and chain in one file',
        content: `${tidy(certificate)}${tidy(chain)}`,
      },
    )
  }
  return files
}
