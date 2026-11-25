import type { DelegationStatus } from '@dr/shared'
import type { AiRequest } from '@dr/shared/ai'
import { z } from 'zod'

/**
 * The setup assistant (docs: "Making AI the core of MyDomainsHub", feature
 * 3): what we already know about a domain's delegation — the nameservers
 * set, what three public resolvers see, how long since the change, whether
 * the registry holds it — put into plain steps by a model. The facts are
 * ours and the model only words them: it is told to invent no nameserver,
 * price, time or promise.
 *
 * The domain's name never leaves: it is replaced everywhere, a child
 * nameserver under it included, so DeepSeek receives hostnames of hosts and
 * nothing that names the customer (NDPA, CMP-11).
 */

export const DOMAIN_PLACEHOLDER = 'your-domain'

export type SetupFacts = {
  /** The set the customer asked for (pending, else current); null = the registrar's default. */
  requested: string[] | null
  /** Waiting for the registry to apply a change. */
  changeWaiting: boolean
  delegation: DelegationStatus
  onHoldAtRegistry: boolean
  /** The host, when picked from our list. */
  host: string | null
  /** Whole hours since the nameservers last changed; null when never changed with us. */
  hoursSinceChange: number | null
  resolvers: { resolver: string; sees: string[] | 'not in DNS' | 'no answer' }[]
}

export type ResolverAnswer =
  | { resolver: string; state: 'answered'; nameservers: string[] }
  | { resolver: string; state: 'nxdomain' }
  | { resolver: string; state: 'no-answer' }

/** A hostname with the domain's own name taken out (a child nameserver like ns1.example.ng). */
export function maskHost(host: string, domain: string): string {
  const name = domain.toLowerCase()
  const value = host.toLowerCase()
  if (value === name) return DOMAIN_PLACEHOLDER
  return value.endsWith(`.${name}`) ? `${value.slice(0, -name.length)}${DOMAIN_PLACEHOLDER}` : value
}

export function setupFacts(input: {
  domain: string
  requested: string[] | null
  changeWaiting: boolean
  delegation: DelegationStatus
  onHold: boolean
  host: string | null
  lastChangedAt: string | null
  views: ResolverAnswer[]
  now: Date
}): SetupFacts {
  const mask = (hosts: string[]) => hosts.map((host) => maskHost(host, input.domain))
  return {
    requested: input.requested ? mask(input.requested) : null,
    changeWaiting: input.changeWaiting,
    delegation: input.delegation,
    onHoldAtRegistry: input.onHold,
    host: input.host,
    hoursSinceChange: input.lastChangedAt
      ? Math.max(0, Math.floor((input.now.getTime() - Date.parse(input.lastChangedAt)) / 3_600_000))
      : null,
    resolvers: input.views.map((view) => ({
      resolver: view.resolver,
      sees:
        view.state === 'answered'
          ? mask(view.nameservers)
          : view.state === 'nxdomain'
            ? 'not in DNS'
            : 'no answer',
    })),
  }
}

export const setupHelpAnswer = z.object({
  summary: z.string().min(1),
  steps: z.array(z.string()).max(8),
})

export type SetupHelp = { summary: string; steps: string[] }

const SYSTEM = (
  supportEmail: string,
) => `You help a customer of MyDomainsHub, a domain registrar in Nigeria, understand whether their domain is pointed at their web host.
You are given facts as json. Explain them in plain English to someone who is not technical.
Reply in json only, exactly in this form: {"summary":"One or two sentences on what is happening.","steps":["What to do next, one short sentence each"]}.
Give at most 4 steps; give none if nothing needs doing.
Facts you may rely on, and nothing else:
- MyDomainsHub does not host websites, email or DNS records. Website and email records are set at the customer's host.
- After nameservers change, public resolvers usually catch up within a few hours; some keep the old answer for up to 48 hours.
- "requested" is what the customer set; null means the registrar's default nameservers are still in use.
- If "onHoldAtRegistry" is true, the registry has put the domain on hold and it will not work anywhere until that is lifted: tell them to email ${supportEmail}.
- ${DOMAIN_PLACEHOLDER} stands for the customer's domain.
Never invent a nameserver, a time, a price or a promise. Never suggest moving the domain to another registrar.`

export function setupHelpRequest(facts: SetupFacts, supportEmail: string): AiRequest {
  return {
    system: SYSTEM(supportEmail),
    user: JSON.stringify(facts),
    maxTokens: 600,
    temperature: 0.3,
  }
}

const SUMMARY_MAX = 400
const STEP_MAX = 220

export function cleanSetupHelp(answer: z.infer<typeof setupHelpAnswer>): SetupHelp {
  const tidy = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)
  return {
    summary: tidy(answer.summary, SUMMARY_MAX),
    steps: answer.steps
      .map((step) => tidy(step, STEP_MAX))
      .filter(Boolean)
      .slice(0, 4),
  }
}
