# ChatGPT plugin directory — MyDomainsHub

AI phase 5. OpenAI calls ChatGPT apps "plugins" now. You submit a ZIP, not a URL.
The package is ready in [`integrations/chatgpt-plugin/`](../integrations/chatgpt-plugin/),
written to OpenAI's "Upload and submit your plugin" page (read 26 Nov 2026).

## What ChatGPT gets

`https://www.mydomainshub.com/mcp/chatgpt` is the same server as `/mcp`, with two
tools only:

- `search_domains`
- `get_prices`

It has **no `create_cart_link`**. OpenAI's plugin guidelines (5.1) allow commerce
only for physical goods. They also bar a plugin from linking directly to a checkout.
A cart link does that. So the package declares `commerce: false`. People who want a
name buy it on mydomainshub.com themselves.

Every tool sets `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit
booleans (rule 6.3). A test holds that.

ChatGPT's requests come from OpenAI's published ranges
(`https://openai.com/chatgpt-connectors.json`, read daily). They share one bucket of
600 calls in 10 minutes, as Claude's do. Searches from every assistant together stay
under `mcpSearchAll`.

## Owner steps

Only an Owner of the OpenAI platform organisation can submit, or a member with
**Apps Management Write**.

1. **Verify the business.** In platform.openai.com → Settings → Organization →
   General, complete business verification as CLOOP UNIVERSE TECH LTD. The directory
   shows that name.
2. **Make the ZIP.** From the repo root:
   `cd integrations/chatgpt-plugin && zip -r ../../mydomainshub-chatgpt-plugin.zip . -x '.*'`
3. **Upload it.** Use Plugins → create a draft → upload the ZIP. Check the imported
   listing, then fix anything the metadata check flags in `plugin.json` and upload
   again.
4. **Connect the server and verify the domain.**
   - Open MCPs → mydomainshub → Connect. Authentication: none.
   - The portal shows a challenge token. In Vercel (Production), set
     `OPENAI_APPS_CHALLENGE` to that token, then redeploy.
   - Check that `curl https://www.mydomainshub.com/.well-known/openai-apps-challenge`
     prints the token alone.
   - Then press Connect and wait for the tool scan.
5. **Record the demo.** Run the five positive cases in `plugin.json` in ChatGPT
   (developer mode, connected to the URL above) and record it.
   - Add the video's link to `extensions.com.openai.review.demo_recording_url`.
   - Re-zip and upload. Or enter the link in Review details.
   - No reviewer credentials are needed: nothing signs in.
6. **Submit for review.** Answer the policy attestations, then publish once approved.

## Choices left to you

- **Countries.** `publication.countries` is left out, so there is no restriction. Add
  `["NG"]` to limit it to Nigeria.
- **Category.** The package says Productivity. Pick another in the dashboard if its
  list has a closer one.
- **Telling people.** `/ai-assistants` names only Claude. Add ChatGPT once the
  listing is live, not before (N9b).
