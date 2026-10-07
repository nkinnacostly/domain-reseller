import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The e2e run's Domain Connect signing key (MAIL-SPEC §5.3), in place of
 * production's: made once per machine and port, outside the repo, so no
 * private key is ever committed. playwright.config.ts gives the private half
 * to the server (MAIL_DOMAIN_CONNECT_PRIVATE_KEY, which process env sets over
 * .env); the spec checks the signature with the public half, as Cloudflare
 * would with the key at _dck1.mydomainshub.com.
 */
export function dcKeyFiles(port: number | string) {
  const dir = join(tmpdir(), `mdm-mail-e2e-dc-${port}`)
  const publicFile = join(dir, 'public.b64')
  const privateFile = join(dir, 'private.b64')
  if (!existsSync(publicFile) || !existsSync(privateFile)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(
      privateFile,
      privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      {
        mode: 0o600,
      },
    )
    writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
  }
  return {
    privateBase64: () => readFileSync(privateFile, 'utf8').trim(),
    publicBase64: () => readFileSync(publicFile, 'utf8').trim(),
  }
}
