import { ChatCircleDots, MagnifyingGlass, Robot } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'Use with AI assistants',
  description: `Check domain names and naira prices at ${BUSINESS.brand} from Claude and other AI assistants, through our MCP server. It searches and quotes; you buy on our site.`,
  path: '/ai-assistants',
})

/**
 * The MCP server's public documentation (feature 8; the Claude directory
 * asks for one). Every sentence describes what app/mcp/route.ts and
 * features/mcp do (N9b): three read-only tools, same prices, nothing bought,
 * searches not logged.
 */
export default function AiAssistantsPage() {
  const server = new URL('/mcp', env.NEXT_PUBLIC_APP_URL).toString()
  return (
    <LegalPage
      path="/ai-assistants"
      title="Use MyDomainsHub with AI assistants"
      nav="none"
      icons={[Robot, MagnifyingGlass, ChatCircleDots]}
      intro={
        <p>
          Ask an AI assistant to find you a domain name, and it can check with us whether the name
          is free and what it costs in naira — then hand you a link to buy it here.
        </p>
      }
    >
      <LegalSection id="connect" title="Connect it">
        <p>
          {BUSINESS.brand} runs an MCP (Model Context Protocol) server at <code>{server}</code>. It
          needs no account or sign-in. In Claude, add it as a custom connector with that address; in
          any other assistant that supports remote MCP servers, add a server with the same address.
        </p>
      </LegalSection>

      <LegalSection id="tools" title="What it can do">
        <ul>
          <li>
            <strong>Search domain names</strong> — whether a name is free on the extension you ask
            for and on popular ones, each free name with its price and its renewal price.
          </li>
          <li>
            <strong>Domain prices</strong> — what an extension costs to register, renew and transfer
            in.
          </li>
          <li>
            <strong>Link to buy</strong> — a link to this site listing the names you chose, with
            their prices. Opening it adds nothing to your cart.
          </li>
        </ul>
        <p>
          Try asking: “Find me a short .com for a bakery in Ibadan and check it at MyDomainsHub”, or
          “What does a .africa domain cost at MyDomainsHub?”
        </p>
      </LegalSection>

      <LegalSection id="not" title="What it does not do">
        <p>
          The server cannot sign in, see an account, add to a cart, take payment, register a domain
          or change one. You buy on this site: open the link, press Add, and check out as usual.
          Each name is checked again when you add it, and again before you pay, because someone else
          may have registered it in the meantime.
        </p>
      </LegalSection>

      <LegalSection id="prices" title="Prices">
        <p>
          The same prices as on this site, in naira, each shown with its renewal price, before VAT,
          which checkout adds as its own line. Assistants get no special price. The{' '}
          <Link href="/pricing">pricing page</Link> lists every extension.
        </p>
      </LegalSection>

      <LegalSection id="privacy" title="Privacy and limits">
        <p>
          The assistant sends us only the names and extensions it asks about. We do not log or keep
          searches, and nothing the server receives is linked to an account. To share the registry’s
          capacity fairly, we count requests by address; past a limit the server asks to try again
          in a minute. What your assistant does with your conversation is covered by its own privacy
          policy; ours is in the <Link href="/legal/privacy">privacy notice</Link>.
        </p>
      </LegalSection>

      <LegalSection id="help" title="Help">
        <p>
          Something not working? Email <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
