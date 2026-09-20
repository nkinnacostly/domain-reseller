import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Loads the workspace-root .env for scripts run outside Next. */
export function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL('../../../../.env', import.meta.url))
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
}
