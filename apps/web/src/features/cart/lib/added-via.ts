/**
 * Where a cart line came from, when it came from an AI feature (AI phase 4,
 * migration 75): the name finder, or a link an AI assistant made through the
 * MCP server. Copied to the order line and counted on the admin AI page — a
 * hint for counting only, sent by the browser, so nothing prices, checks or
 * registers by it.
 */
export const ADDED_VIA = ['name_finder', 'assistant_link'] as const

export type AddedVia = (typeof ADDED_VIA)[number]
