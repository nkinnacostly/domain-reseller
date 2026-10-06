import { connection } from 'next/server'
import { openApi } from '@/features/api/handlers/openapi'
import { otherMethods, runApi } from '@/features/api/lib/handler'

/** GET /api/v1/openapi.json — the API described, OpenAPI 3.1 (MAIL-SPEC §6). */
export async function GET() {
  // At request time: every answer carries its own x-request-id.
  await connection()
  return runApi(
    'GET /v1/openapi.json',
    () => null,
    async (_, requestId) => openApi(requestId),
  )
}

export const { POST, PATCH, PUT, DELETE } = otherMethods(['GET'])
