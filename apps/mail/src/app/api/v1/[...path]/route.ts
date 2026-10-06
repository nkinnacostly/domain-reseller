import { noSuchPath } from '@/features/api/lib/handler'

/**
 * Any /api/v1 path that does not exist: the API's JSON 404 with
 * x-request-id (MAIL-SPEC §6), never the site's HTML not-found page.
 */
export const GET = noSuchPath
export const POST = noSuchPath
export const PATCH = noSuchPath
export const PUT = noSuchPath
export const DELETE = noSuchPath
