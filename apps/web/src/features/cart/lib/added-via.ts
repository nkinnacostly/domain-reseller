/**
 * Where a cart line came from, when it came from an AI feature (AI phases 4
 * and 5, migrations 75–76): the name finder, a link an AI assistant made
 * through the MCP server, or an answer from the site assistant. Copied to the order line and counted on the admin AI page — a
 * hint for counting only, sent by the browser, so nothing prices, checks or
 * registers by it.
 */
export const ADDED_VIA = ['name_finder', 'assistant_link', 'site_assistant'] as const

export type AddedVia = (typeof ADDED_VIA)[number]
