import type { Database, Json } from './database.types'

/**
 * Schema `mail` (MyDomainsHub Mail, migrations 43–44), for apps/mail and
 * apps/mail-worker.
 *
 * Until the generated types are regenerated with `--schema public,mail`
 * after those migrations are applied, `Database` has no `mail` key; this
 * stand-in describes only what the apps call today, in the shape the
 * generator writes (args without a default required, with one optional;
 * jsonb as Json). Once `database.types.ts` has `mail`, `MailDatabase` *is*
 * the generated `Database` and this stand-in is dead: delete it then.
 */

type Fn<Args, Returns> = { Args: Args; Returns: Returns }
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }

type PendingMailSchema = {
  Tables: {
    accounts: Table<{
      id: string
      short_id: string
      name: string
      plan_code: string
      state: string
      ses_tenant: string
      config_set: string
      ses_status: string
      created_at: string
    }>
    members: Table<{
      account_id: string
      user_id: string
      role: string
      invited_by: string | null
      created_at: string
    }>
  }
  Views: { [_ in never]: never }
  Functions: {
    authenticate_key: Fn<{ p_key_hash: string }, Json>
    enqueue_email: Fn<
      {
        p_account_id: string
        p_api_key_id: string
        p_email: Json
        p_payload: Json
        p_idempotency_key?: string
        p_request_hash?: string
      },
      Json
    >
    get_email: Fn<{ p_account_id: string; p_public_id: string }, Json>
    claim_sends: Fn<{ p_worker: string; p_limit: number; p_paid_only?: boolean }, Json>
    record_send_result: Fn<
      {
        p_email_id: number
        p_worker: string
        p_outcome: string
        p_message_id?: string
        p_error_code?: string
        p_retry_after_seconds?: number
      },
      Json
    >
    record_send_event: Fn<
      {
        p_event: string
        p_message_id?: string
        p_email_public_id?: string
        p_event_key?: string
        p_occurred_at?: string
        p_detail?: Json
        p_recipients?: number
        p_suppress?: string[]
      },
      boolean
    >
    create_account: Fn<
      {
        p_name: string
        p_website?: string
        p_use_case?: string
        p_expected_monthly_volume?: number
      },
      Json
    >
  }
  Enums: { [_ in never]: never }
  CompositeTypes: { [_ in never]: never }
}

export type MailDatabase = Database extends { mail: unknown }
  ? Database
  : Database & { mail: PendingMailSchema }
