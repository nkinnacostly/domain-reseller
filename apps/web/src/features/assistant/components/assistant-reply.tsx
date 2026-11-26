'use client'

import Link from 'next/link'
import { FormMessage } from '@/components/common/form-parts'
import { ResultItem } from '@/features/search/components/result-list'
import { BUSINESS } from '@/lib/business'
import type { AskAssistantResult, AssistantFailure, AssistantReply } from '../lib/conversation'

const LINK = 'font-medium text-foreground underline underline-offset-2'

const FAILURE: Record<AssistantFailure, string> = {
  off: 'The assistant isn’t switched on just now. Search, the name finder and the help centre all still work.',
  limited: 'That’s a lot of questions in a few minutes. Wait a little, then ask again.',
  busy: 'The registry asked us to slow down. Try again in a minute.',
  unavailable: 'We couldn’t answer just now. Try again, or use search or the help centre.',
}

/** One answer in the conversation, laid out by the engine that gave it. */
export function AssistantReplyView({ result }: { result: AskAssistantResult }) {
  if (!result.ok) return <FormMessage tone="error">{FAILURE[result.reason]}</FormMessage>
  return <Reply reply={result.reply} />
}

function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-full space-y-2 rounded-2xl rounded-bl-md bg-muted/60 px-3.5 py-2.5 text-sm/6 text-pretty text-foreground">
      {children}
    </div>
  )
}

function Results({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="mt-2 divide-y divide-border/70 overflow-hidden rounded-2xl border border-border bg-background"
    >
      {children}
    </ul>
  )
}

function Reply({ reply }: { reply: AssistantReply }) {
  switch (reply.kind) {
    case 'names':
      return (
        <div>
          <Bubble>
            {reply.notSold ? (
              <p>
                We don’t sell .{reply.notSold}, so these are .{reply.tld} names.
              </p>
            ) : null}
            {reply.ideas.length > 0 ? (
              <p>
                {reply.ideas.length === 1 ? 'One name' : `${reply.ideas.length} names`} free on .
                {reply.tld} right now, checked with the registry:
              </p>
            ) : (
              <p>
                None of the {reply.checked} names I tried on .{reply.tld} are free. Describe it
                another way, or try another extension.
              </p>
            )}
          </Bubble>
          {reply.ideas.length > 0 ? (
            <Results label={`Name ideas on .${reply.tld}`}>
              {reply.ideas.map((idea) => (
                <ResultItem
                  key={idea.row.domain}
                  row={idea.row}
                  note={idea.why}
                  noteLang={reply.language === 'en' ? undefined : reply.language}
                  addedVia="site_assistant"
                />
              ))}
            </Results>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            More options — other extensions and languages — on the{' '}
            <Link href="/ideas" className={LINK}>
              name finder
            </Link>
            .
          </p>
        </div>
      )
    case 'check':
      return (
        <div>
          {reply.notSold.length > 0 ? (
            <Bubble>
              <p>We don’t sell {reply.notSold.join(', ')}.</p>
            </Bubble>
          ) : null}
          {reply.rows.length > 0 ? (
            <Results label="Names checked">
              {reply.rows.map((row) => (
                <ResultItem key={row.domain} row={row} addedVia="site_assistant" />
              ))}
            </Results>
          ) : null}
        </div>
      )
    case 'search':
      return (
        <Bubble>
          <p>
            You’ve checked a lot of names in a few minutes.{' '}
            <Link href={`/search?q=${encodeURIComponent(reply.query)}`} className={LINK}>
              Search for {reply.query}
            </Link>{' '}
            on the search page instead.
          </p>
        </Bubble>
      )
    case 'prices':
      return (
        <Bubble>
          {reply.prices.length > 0 ? (
            <ul className="space-y-1">
              {reply.prices.map((price) => (
                <li key={price.tld}>
                  <span className="font-semibold">.{price.tld}</span> — {price.words}
                </li>
              ))}
            </ul>
          ) : null}
          {reply.notSold.length > 0 ? <p>We don’t sell {reply.notSold.join(', ')}.</p> : null}
          <p className="text-xs text-muted-foreground">
            Before VAT ({reply.vatPct}%), which checkout adds as its own line. Every extension is on
            the{' '}
            <Link href="/pricing" className={LINK}>
              pricing page
            </Link>
            .
          </p>
        </Bubble>
      )
    case 'setup':
      return <Setup reply={reply} />
    case 'help':
      return reply.help.answered ? (
        <Bubble>
          <p>{reply.help.answer}</p>
          {reply.help.sources.length > 0 ? (
            <p className="text-muted-foreground">
              From:{' '}
              {reply.help.sources.map((source, index) => (
                <span key={source.path}>
                  {index > 0 ? ', ' : ''}
                  <Link href={source.path} className={LINK}>
                    {source.title}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
        </Bubble>
      ) : (
        <Bubble>
          <p>
            Our help centre doesn’t cover that. Email{' '}
            <a href={`mailto:${BUSINESS.email}`} className={LINK}>
              {BUSINESS.email}
            </a>{' '}
            and a person will answer.
          </p>
        </Bubble>
      )
    case 'other':
      return (
        <Bubble>
          <p>
            I can find a name for your business, check whether a name is free, show what an
            extension costs, explain how to point your domain at your host, and answer questions
            about MyDomainsHub.
          </p>
        </Bubble>
      )
  }
}

/**
 * How to point a domain (FR-D2, N11): a host's nameservers only from a checked
 * preset, shown as the Nameservers tab will fill them in; otherwise the steps
 * that work for any host.
 */
function Setup({ reply }: { reply: Extract<AssistantReply, { kind: 'setup' }> }) {
  const { preset, host } = reply
  if (preset && !preset.assignsPerZone) {
    return (
      <Bubble>
        <p>To point your domain at {preset.provider}, use these nameservers:</p>
        <ul className="rounded-xl bg-background px-3 py-2 font-mono text-xs/6 break-all">
          {preset.nameservers.map((nameserver) => (
            <li key={nameserver}>{nameserver}</li>
          ))}
        </ul>
        <p>
          In{' '}
          <Link href="/app/domains" className={LINK}>
            My domains
          </Link>
          , open the domain, go to Nameservers and pick {preset.provider} from the list — it fills
          these in. The change needs two-factor authentication, and some networks keep the old
          nameservers for up to 48 hours.
        </p>
        <p className="text-xs text-muted-foreground">
          From{' '}
          <a href={preset.sourceUrl} target="_blank" rel="noreferrer" className={LINK}>
            {preset.provider}’s own instructions
          </a>
          . More in{' '}
          <Link href="/help#pointing" className={LINK}>
            Help: Pointing your domain at your website
          </Link>
          .
        </p>
      </Bubble>
    )
  }
  if (preset) {
    return (
      <Bubble>
        <p>
          {preset.provider} gives each domain its own nameservers. Add your domain in{' '}
          {preset.provider} first, then copy the nameservers it shows you into your domain’s
          Nameservers tab in{' '}
          <Link href="/app/domains" className={LINK}>
            My domains
          </Link>
          .
        </p>
        <p className="text-xs text-muted-foreground">
          From{' '}
          <a href={preset.sourceUrl} target="_blank" rel="noreferrer" className={LINK}>
            {preset.provider}’s own instructions
          </a>
          .
        </p>
      </Bubble>
    )
  }
  return (
    <Bubble>
      <p>
        {host ? `Ask ${host}` : 'Ask your host'} which nameservers to use, then enter them on your
        domain’s Nameservers tab in{' '}
        <Link href="/app/domains" className={LINK}>
          My domains
        </Link>
        . We check them in public DNS before saving.
      </p>
      <p className="text-xs text-muted-foreground">
        Step by step in{' '}
        <Link href="/help#pointing" className={LINK}>
          Help: Pointing your domain at your website
        </Link>
        .
      </p>
    </Bubble>
  )
}
