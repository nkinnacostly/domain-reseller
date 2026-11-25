# Claude connectors directory — MyDomainsHub MCP server

Ready-to-paste answers for the submission portal at https://claude.ai/directory/manage
(**Submit new → MCP connector**). Only a Claude account that may submit for its
organisation can do it: on Pro/Max/Ultra your own account; on Team/Enterprise an
Owner, or a role with the Directory permission. The listing belongs to the
organisation it is submitted from.

Checked live on 25 Nov 2026: every tool answers, each has a `title`,
`readOnlyHint: true` and `destructiveHint: false`.

| Field | Answer |
|---|---|
| Server URL | `https://www.mydomainshub.com/mcp` (Streamable HTTP, no authentication) |
| Name | MyDomainsHub |
| One-liner | Check domain names and naira prices at MyDomainsHub, a domain registrar for Nigeria, and get a link to buy them on our site. |
| Categories | Business / Developer tools (closest the portal offers) |
| Documentation | https://www.mydomainshub.com/ai-assistants |
| Privacy policy | https://www.mydomainshub.com/legal/privacy |
| Support contact | hello@mydomainshub.com |
| Icon | `apps/web/public/brand/mydomainshub-mark.png` |
| Slug | `mydomainshub` |
| Company | CLOOP UNIVERSE TECH LTD, trading as MyDomainsHub — https://www.mydomainshub.com — hello@mydomainshub.com |
| Reads or writes | Reads only |
| Before connecting | Nothing: no account, plan or setup |
| Data handling | Our own API. Availability is read from our registrar supplier (DomainNameAPI), which we resell under agreement. No health data, no sponsored content. |

**Description**

MyDomainsHub sells domain names to people and businesses in Nigeria, priced in naira.
This connector lets Claude check whether a name is free, quote what it costs, and hand
the person a link to buy it.

- Search domain names: whether a name is free on the extension asked for and on popular
  ones. Each free name comes with its first-year price and its renewal price.
- Domain prices: what an extension costs to register, renew and transfer in.
- Link to buy: a mydomainshub.com link listing the chosen names with their prices.

The connector is read-only. It cannot sign in, see an account, add to a cart, take
payment, or register or change a domain. The person buys on our site. They open the
link, press Add, and check out. Each name is checked again before payment. Prices
are the same as on the site, before VAT. Searches are not logged.

**Primary use cases**: finding an available domain for a business or project;
comparing extension prices in naira, including renewal; getting a link to buy the
chosen names.

**Compliance step**: the portal asks the submitter to acknowledge seven policies:
directory guidelines, first-party API use, financial transactions, AI media generation,
prompt injection, conversation data collection and public documentation. These are the
company's commitments, so the submitter accepts them. Under the financial-transactions
policy, the connector moves no money: payment happens only on our site, by the person.
