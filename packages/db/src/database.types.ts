export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          admin_label: string
          admin_role: string
          created_at: string
          detail: Json
          error: string | null
          error_code: string | null
          id: number
          outcome: string
          parent_id: number | null
          reason: string | null
          redacted_at: string | null
          request_id: string | null
          request_key: string | null
          session_hash: string | null
          side: string | null
          target_id: string | null
          target_test_mode: boolean | null
          target_type: string | null
          test_actor: boolean
        }
        Insert: {
          action: string
          admin_id: string
          admin_label: string
          admin_role: string
          created_at?: string
          detail?: Json
          error?: string | null
          error_code?: string | null
          id?: never
          outcome: string
          parent_id?: number | null
          reason?: string | null
          redacted_at?: string | null
          request_id?: string | null
          request_key?: string | null
          session_hash?: string | null
          side?: string | null
          target_id?: string | null
          target_test_mode?: boolean | null
          target_type?: string | null
          test_actor: boolean
        }
        Update: {
          action?: string
          admin_id?: string
          admin_label?: string
          admin_role?: string
          created_at?: string
          detail?: Json
          error?: string | null
          error_code?: string | null
          id?: never
          outcome?: string
          parent_id?: number | null
          reason?: string | null
          redacted_at?: string | null
          request_id?: string | null
          request_key?: string | null
          session_hash?: string | null
          side?: string | null
          target_id?: string | null
          target_test_mode?: boolean | null
          target_type?: string | null
          test_actor?: boolean
        }
        Relationships: []
      }
      admin_changes: {
        Row: {
          at: string
          db_user: string
          factor_count: number | null
          id: number
          label: string
          op: string
          revoked: boolean
          role: string | null
          test_only: boolean
        }
        Insert: {
          at?: string
          db_user?: string
          factor_count?: number | null
          id?: never
          label: string
          op: string
          revoked: boolean
          role?: string | null
          test_only: boolean
        }
        Update: {
          at?: string
          db_user?: string
          factor_count?: number | null
          id?: never
          label?: string
          op?: string
          revoked?: boolean
          role?: string | null
          test_only?: boolean
        }
        Relationships: []
      }
      admin_note_claims: {
        Row: {
          audit_id: number
          claimed_at: string
        }
        Insert: {
          audit_id: number
          claimed_at?: string
        }
        Update: {
          audit_id?: number
          claimed_at?: string
        }
        Relationships: []
      }
      admins: {
        Row: {
          added_at: string
          added_by: string
          label: string
          mfa_factor_ids: string[]
          revoked_at: string | null
          role: string
          test_only: boolean
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by: string
          label: string
          mfa_factor_ids: string[]
          revoked_at?: string | null
          role: string
          test_only?: boolean
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string
          label?: string
          mfa_factor_ids?: string[]
          revoked_at?: string | null
          role?: string
          test_only?: boolean
          user_id?: string
        }
        Relationships: []
      }
      bulk_operation_items: {
        Row: {
          domain_id: string
          domain_name: string
          job_id: string | null
          operation_id: string
          outcome: string
          reason: string | null
        }
        Insert: {
          domain_id: string
          domain_name: string
          job_id?: string | null
          operation_id: string
          outcome: string
          reason?: string | null
        }
        Update: {
          domain_id?: string
          domain_name?: string
          job_id?: string | null
          operation_id?: string
          outcome?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bulk_operation_items_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_operation_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_operation_items_operation_id_fkey"
            columns: ["operation_id"]
            isOneToOne: false
            referencedRelation: "bulk_operations"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_operations: {
        Row: {
          created_at: string
          id: string
          kind: string
          params: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          params?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          params?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bulk_operations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cart_items: {
        Row: {
          auto_renew: boolean
          cart_id: string
          created_at: string
          domain: string
          id: string
          period_years: number
          privacy: boolean
          quoted_at: string
          quoted_fx_rate_id: string
          quoted_renewal_kobo: number
          quoted_total_kobo: number
          tld: string
        }
        Insert: {
          auto_renew?: boolean
          cart_id: string
          created_at?: string
          domain: string
          id?: string
          period_years?: number
          privacy?: boolean
          quoted_at?: string
          quoted_fx_rate_id: string
          quoted_renewal_kobo: number
          quoted_total_kobo: number
          tld: string
        }
        Update: {
          auto_renew?: boolean
          cart_id?: string
          created_at?: string
          domain?: string
          id?: string
          period_years?: number
          privacy?: boolean
          quoted_at?: string
          quoted_fx_rate_id?: string
          quoted_renewal_kobo?: number
          quoted_total_kobo?: number
          tld?: string
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_quoted_fx_rate_id_fkey"
            columns: ["quoted_fx_rate_id"]
            isOneToOne: false
            referencedRelation: "fx_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      cart_ssl_items: {
        Row: {
          cart_id: string
          common_name: string
          created_at: string
          id: string
          product_code: string
          quoted_at: string
          quoted_fx_rate_id: string
          quoted_total_kobo: number
        }
        Insert: {
          cart_id: string
          common_name: string
          created_at?: string
          id?: string
          product_code: string
          quoted_at?: string
          quoted_fx_rate_id: string
          quoted_total_kobo: number
        }
        Update: {
          cart_id?: string
          common_name?: string
          created_at?: string
          id?: string
          product_code?: string
          quoted_at?: string
          quoted_fx_rate_id?: string
          quoted_total_kobo?: number
        }
        Relationships: [
          {
            foreignKeyName: "cart_ssl_items_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_ssl_items_product_code_fkey"
            columns: ["product_code"]
            isOneToOne: false
            referencedRelation: "ssl_products"
            referencedColumns: ["product_code"]
          },
          {
            foreignKeyName: "cart_ssl_items_quoted_fx_rate_id_fkey"
            columns: ["quoted_fx_rate_id"]
            isOneToOne: false
            referencedRelation: "fx_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      carts: {
        Row: {
          anon_token_hash: string | null
          created_at: string
          id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          anon_token_hash?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          anon_token_hash?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "carts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_notices: {
        Row: {
          channel: string
          created_at: string
          delivery_checked_at: string | null
          delivery_status: string
          domain_id: string | null
          domain_name: string
          email_id: string | null
          expires_at: string
          id: string
          notice_type: string
          provider_message_id: string | null
          recipient: string
          sent_at: string
          template_version: string
          user_id: string | null
        }
        Insert: {
          channel?: string
          created_at?: string
          delivery_checked_at?: string | null
          delivery_status?: string
          domain_id?: string | null
          domain_name: string
          email_id?: string | null
          expires_at: string
          id?: string
          notice_type: string
          provider_message_id?: string | null
          recipient: string
          sent_at: string
          template_version: string
          user_id?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          delivery_checked_at?: string | null
          delivery_status?: string
          domain_id?: string | null
          domain_name?: string
          email_id?: string | null
          expires_at?: string
          id?: string
          notice_type?: string
          provider_message_id?: string | null
          recipient?: string
          sent_at?: string
          template_version?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_notices_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_notices_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: true
            referencedRelation: "email_outbox"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_notices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_profiles: {
        Row: {
          address_line1: string
          address_line2: string | null
          address_line3: string | null
          city: string
          company: string | null
          country: string
          created_at: string
          email: string
          fax: string | null
          fax_country_code: string | null
          first_name: string
          id: string
          is_default: boolean
          label: string
          last_name: string
          phone: string
          phone_country_code: string
          state: string
          updated_at: string
          user_id: string
          zip_code: string
        }
        Insert: {
          address_line1: string
          address_line2?: string | null
          address_line3?: string | null
          city: string
          company?: string | null
          country: string
          created_at?: string
          email: string
          fax?: string | null
          fax_country_code?: string | null
          first_name: string
          id?: string
          is_default?: boolean
          label: string
          last_name: string
          phone: string
          phone_country_code: string
          state: string
          updated_at?: string
          user_id: string
          zip_code: string
        }
        Update: {
          address_line1?: string
          address_line2?: string | null
          address_line3?: string | null
          city?: string
          company?: string | null
          country?: string
          created_at?: string
          email?: string
          fax?: string | null
          fax_country_code?: string | null
          first_name?: string
          id?: string
          is_default?: boolean
          label?: string
          last_name?: string
          phone?: string
          phone_country_code?: string
          state?: string
          updated_at?: string
          user_id?: string
          zip_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          domain_id: string
          event_type: string
          id: number
          payload: Json
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          created_at?: string
          domain_id: string
          event_type: string
          id?: number
          payload?: Json
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          domain_id?: string
          event_type?: string
          id?: number
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "domain_events_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_label_links: {
        Row: {
          created_at: string
          domain_id: string
          label_id: string
        }
        Insert: {
          created_at?: string
          domain_id: string
          label_id: string
        }
        Update: {
          created_at?: string
          domain_id?: string
          label_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "domain_label_links_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "domain_label_links_label_id_fkey"
            columns: ["label_id"]
            isOneToOne: false
            referencedRelation: "domain_labels"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_labels: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          name: string
          user_id?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "domain_labels_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_nameserver_history: {
        Row: {
          after: string[]
          before: string[] | null
          changed_at: string
          domain_id: string
          id: number
        }
        Insert: {
          after: string[]
          before?: string[] | null
          changed_at?: string
          domain_id: string
          id?: number
        }
        Update: {
          after?: string[]
          before?: string[] | null
          changed_at?: string
          domain_id?: string
          id?: number
        }
        Relationships: [
          {
            foreignKeyName: "domain_nameserver_history_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
        ]
      }
      domains: {
        Row: {
          auto_renew: boolean
          contacts: Json | null
          created_at: string
          deep_checked_at: string | null
          delegation_checked_at: string | null
          delegation_status: Database["public"]["Enums"]["delegation_status"]
          domain_name: string
          expires_at: string | null
          id: string
          local_status: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_item_id: string | null
          pending_contacts: Json | null
          pending_nameservers: string[] | null
          pending_privacy: boolean | null
          pending_registrant: Json | null
          pending_transfer_lock: boolean | null
          previous_nameservers: string[] | null
          privacy_enabled: boolean
          registered_at: string | null
          registrant: Json | null
          registry_checked_at: string | null
          registry_renewal_mode: string | null
          registry_status: string | null
          source: string
          test_mode: boolean
          tld: string
          transfer_lock: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_renew?: boolean
          contacts?: Json | null
          created_at?: string
          deep_checked_at?: string | null
          delegation_checked_at?: string | null
          delegation_status?: Database["public"]["Enums"]["delegation_status"]
          domain_name: string
          expires_at?: string | null
          id?: string
          local_status?: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_item_id?: string | null
          pending_contacts?: Json | null
          pending_nameservers?: string[] | null
          pending_privacy?: boolean | null
          pending_registrant?: Json | null
          pending_transfer_lock?: boolean | null
          previous_nameservers?: string[] | null
          privacy_enabled?: boolean
          registered_at?: string | null
          registrant?: Json | null
          registry_checked_at?: string | null
          registry_renewal_mode?: string | null
          registry_status?: string | null
          source: string
          test_mode?: boolean
          tld: string
          transfer_lock?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_renew?: boolean
          contacts?: Json | null
          created_at?: string
          deep_checked_at?: string | null
          delegation_checked_at?: string | null
          delegation_status?: Database["public"]["Enums"]["delegation_status"]
          domain_name?: string
          expires_at?: string | null
          id?: string
          local_status?: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_item_id?: string | null
          pending_contacts?: Json | null
          pending_nameservers?: string[] | null
          pending_privacy?: boolean | null
          pending_registrant?: Json | null
          pending_transfer_lock?: boolean | null
          previous_nameservers?: string[] | null
          privacy_enabled?: boolean
          registered_at?: string | null
          registrant?: Json | null
          registry_checked_at?: string | null
          registry_renewal_mode?: string | null
          registry_status?: string | null
          source?: string
          test_mode?: boolean
          tld?: string
          transfer_lock?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "domains_nameserver_preset_id_fkey"
            columns: ["nameserver_preset_id"]
            isOneToOne: false
            referencedRelation: "nameserver_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "domains_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: true
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "domains_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      email_outbox: {
        Row: {
          attempts: number
          category: string
          claimed_at: string | null
          claimed_by: string | null
          complained_at: string | null
          created_at: string
          data: Json
          dedupe_key: string
          delivery_checked_at: string | null
          delivery_detail: Json | null
          delivery_status: string | null
          domain_id: string | null
          id: string
          kind: string
          last_error: string | null
          next_attempt_at: string
          order_id: string | null
          provider_message_id: string | null
          sent_at: string | null
          skip_reason: string | null
          status: string
          template_version: string | null
          test_mode: boolean
          to_email: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          attempts?: number
          category: string
          claimed_at?: string | null
          claimed_by?: string | null
          complained_at?: string | null
          created_at?: string
          data?: Json
          dedupe_key: string
          delivery_checked_at?: string | null
          delivery_detail?: Json | null
          delivery_status?: string | null
          domain_id?: string | null
          id?: string
          kind: string
          last_error?: string | null
          next_attempt_at?: string
          order_id?: string | null
          provider_message_id?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          status?: string
          template_version?: string | null
          test_mode?: boolean
          to_email: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          attempts?: number
          category?: string
          claimed_at?: string | null
          claimed_by?: string | null
          complained_at?: string | null
          created_at?: string
          data?: Json
          dedupe_key?: string
          delivery_checked_at?: string | null
          delivery_detail?: Json | null
          delivery_status?: string | null
          domain_id?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          next_attempt_at?: string
          order_id?: string | null
          provider_message_id?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          status?: string
          template_version?: string | null
          test_mode?: boolean
          to_email?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_outbox_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_outbox_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_outbox_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      float_topups: {
        Row: {
          id: number
          ngn_paid_kobo: number
          recorded_at: string
          recorded_by: string
          reference: string
          supersedes_id: number | null
          trace_id: string
          usd_cents: number
        }
        Insert: {
          id?: never
          ngn_paid_kobo: number
          recorded_at?: string
          recorded_by: string
          reference: string
          supersedes_id?: number | null
          trace_id: string
          usd_cents: number
        }
        Update: {
          id?: never
          ngn_paid_kobo?: number
          recorded_at?: string
          recorded_by?: string
          reference?: string
          supersedes_id?: number | null
          trace_id?: string
          usd_cents?: number
        }
        Relationships: []
      }
      flw_refund_checks: {
        Row: {
          amount_kobo: number | null
          audit_id: number | null
          created_at: string
          currency: string | null
          disburse_status: string | null
          flw_refund_id: string
          id: number
          state: string
          status: string | null
          target_id: string
          target_type: string
          test_mode: boolean
          tx_id: string | null
        }
        Insert: {
          amount_kobo?: number | null
          audit_id?: number | null
          created_at?: string
          currency?: string | null
          disburse_status?: string | null
          flw_refund_id: string
          id?: never
          state: string
          status?: string | null
          target_id: string
          target_type: string
          test_mode: boolean
          tx_id?: string | null
        }
        Update: {
          amount_kobo?: number | null
          audit_id?: number | null
          created_at?: string
          currency?: string | null
          disburse_status?: string | null
          flw_refund_id?: string
          id?: never
          state?: string
          status?: string | null
          target_id?: string
          target_type?: string
          test_mode?: boolean
          tx_id?: string | null
        }
        Relationships: []
      }
      funnel_daily: {
        Row: {
          count: number
          day: string
          event: string
          test_mode: boolean
        }
        Insert: {
          count?: number
          day: string
          event: string
          test_mode: boolean
        }
        Update: {
          count?: number
          day?: string
          event?: string
          test_mode?: boolean
        }
        Relationships: []
      }
      fx_rates: {
        Row: {
          base: string
          buffer_pct: number
          buy_rate: number
          costing_rate: number
          created_at: string
          effective_from: string | null
          id: string
          move_pct: number | null
          quote: string
          quoted_at: string
          raw_payload: Json | null
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sell_rate: number
          source: Database["public"]["Enums"]["fx_source"]
          status: Database["public"]["Enums"]["fx_status"]
        }
        Insert: {
          base?: string
          buffer_pct?: number
          buy_rate: number
          costing_rate: number
          created_at?: string
          effective_from?: string | null
          id?: string
          move_pct?: number | null
          quote?: string
          quoted_at: string
          raw_payload?: Json | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sell_rate: number
          source: Database["public"]["Enums"]["fx_source"]
          status?: Database["public"]["Enums"]["fx_status"]
        }
        Update: {
          base?: string
          buffer_pct?: number
          buy_rate?: number
          costing_rate?: number
          created_at?: string
          effective_from?: string | null
          id?: string
          move_pct?: number | null
          quote?: string
          quoted_at?: string
          raw_payload?: Json | null
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          sell_rate?: number
          source?: Database["public"]["Enums"]["fx_source"]
          status?: Database["public"]["Enums"]["fx_status"]
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          baseline_expiry: string | null
          created_at: string
          domain_id: string
          finished_at: string | null
          id: string
          idempotency_key: string
          kind: Database["public"]["Enums"]["job_kind"]
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          order_item_id: string | null
          run_after: string
          status: Database["public"]["Enums"]["job_status"]
          submitted_at: string | null
          test_mode: boolean
          updated_at: string
        }
        Insert: {
          attempts?: number
          baseline_expiry?: string | null
          created_at?: string
          domain_id: string
          finished_at?: string | null
          id?: string
          idempotency_key: string
          kind: Database["public"]["Enums"]["job_kind"]
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          order_item_id?: string | null
          run_after?: string
          status?: Database["public"]["Enums"]["job_status"]
          submitted_at?: string | null
          test_mode: boolean
          updated_at?: string
        }
        Update: {
          attempts?: number
          baseline_expiry?: string | null
          created_at?: string
          domain_id?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          kind?: Database["public"]["Enums"]["job_kind"]
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          order_item_id?: string | null
          run_after?: string
          status?: Database["public"]["Enums"]["job_status"]
          submitted_at?: string | null
          test_mode?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      known_devices: {
        Row: {
          device: string
          first_seen_at: string
          last_seen_at: string
          user_id: string
        }
        Insert: {
          device: string
          first_seen_at?: string
          last_seen_at?: string
          user_id: string
        }
        Update: {
          device?: string
          first_seen_at?: string
          last_seen_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "known_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      market_references: {
        Row: {
          lowest_ngn: number | null
          observed_on: string
          source_note: string
          tld: string
          typical_ngn: number
          updated_at: string
        }
        Insert: {
          lowest_ngn?: number | null
          observed_on?: string
          source_note: string
          tld: string
          typical_ngn: number
          updated_at?: string
        }
        Update: {
          lowest_ngn?: number | null
          observed_on?: string
          source_note?: string
          tld?: string
          typical_ngn?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "market_references_tld_fkey"
            columns: ["tld"]
            isOneToOne: true
            referencedRelation: "tlds"
            referencedColumns: ["name"]
          },
        ]
      }
      metrics_daily: {
        Row: {
          day: string
          metric: string
          test_mode: boolean
          value: number
        }
        Insert: {
          day: string
          metric: string
          test_mode: boolean
          value: number
        }
        Update: {
          day?: string
          metric?: string
          test_mode?: boolean
          value?: number
        }
        Relationships: []
      }
      nameserver_preset_drafts: {
        Row: {
          assigns_per_zone: boolean
          check_detail: Json | null
          check_ok: boolean | null
          checked_at: string | null
          discarded_at: string | null
          id: string
          nameservers: string[]
          notes: string | null
          preset_id: string | null
          provider: string
          published_at: string | null
          saved_at: string
          saved_by: string
          source_url: string
        }
        Insert: {
          assigns_per_zone?: boolean
          check_detail?: Json | null
          check_ok?: boolean | null
          checked_at?: string | null
          discarded_at?: string | null
          id?: string
          nameservers?: string[]
          notes?: string | null
          preset_id?: string | null
          provider: string
          published_at?: string | null
          saved_at?: string
          saved_by: string
          source_url: string
        }
        Update: {
          assigns_per_zone?: boolean
          check_detail?: Json | null
          check_ok?: boolean | null
          checked_at?: string | null
          discarded_at?: string | null
          id?: string
          nameservers?: string[]
          notes?: string | null
          preset_id?: string | null
          provider?: string
          published_at?: string | null
          saved_at?: string
          saved_by?: string
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "nameserver_preset_drafts_preset_id_fkey"
            columns: ["preset_id"]
            isOneToOne: false
            referencedRelation: "nameserver_presets"
            referencedColumns: ["id"]
          },
        ]
      }
      nameserver_preset_sources: {
        Row: {
          host: string
          provider: string
        }
        Insert: {
          host: string
          provider: string
        }
        Update: {
          host?: string
          provider?: string
        }
        Relationships: []
      }
      nameserver_presets: {
        Row: {
          assigns_per_zone: boolean
          auto_hidden_at: string | null
          check_failed_since: string | null
          created_at: string
          id: string
          is_hidden: boolean
          last_check: Json | null
          last_checked_at: string | null
          nameservers: string[]
          notes: string | null
          provider: string
          registrar_default_for: string | null
          source_url: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          assigns_per_zone?: boolean
          auto_hidden_at?: string | null
          check_failed_since?: string | null
          created_at?: string
          id?: string
          is_hidden?: boolean
          last_check?: Json | null
          last_checked_at?: string | null
          nameservers?: string[]
          notes?: string | null
          provider: string
          registrar_default_for?: string | null
          source_url: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          assigns_per_zone?: boolean
          auto_hidden_at?: string | null
          check_failed_since?: string | null
          created_at?: string
          id?: string
          is_hidden?: boolean
          last_check?: Json | null
          last_checked_at?: string | null
          nameservers?: string[]
          notes?: string | null
          provider?: string
          registrar_default_for?: string | null
          source_url?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      ops_alerts: {
        Row: {
          first_seen_at: string
          id: number
          key: string
          kind: string
          last_seen_at: string
          notified_at: string | null
          notify_count: number
          resolved_at: string | null
          resolved_notified_at: string | null
          severity: string
          summary: string
          test_mode: boolean
        }
        Insert: {
          first_seen_at?: string
          id?: number
          key: string
          kind: string
          last_seen_at?: string
          notified_at?: string | null
          notify_count?: number
          resolved_at?: string | null
          resolved_notified_at?: string | null
          severity: string
          summary: string
          test_mode: boolean
        }
        Update: {
          first_seen_at?: string
          id?: number
          key?: string
          kind?: string
          last_seen_at?: string
          notified_at?: string | null
          notify_count?: number
          resolved_at?: string | null
          resolved_notified_at?: string | null
          severity?: string
          summary?: string
          test_mode?: boolean
        }
        Relationships: []
      }
      ops_settings: {
        Row: {
          auto_refund_daily_max_kobo: number
          auto_refund_max_kobo: number
          float_alert_usd: number
          id: boolean
          max_domains_per_account_day: number
          refund_delay_minutes: number
          stuck_order_minutes: number
          updated_at: string
          velocity_new_max: number
          velocity_standard_after_days: number
          velocity_trusted_after_days: number
          velocity_trusted_after_paid_orders: number
          velocity_trusted_max: number
        }
        Insert: {
          auto_refund_daily_max_kobo?: number
          auto_refund_max_kobo?: number
          float_alert_usd?: number
          id?: boolean
          max_domains_per_account_day?: number
          refund_delay_minutes?: number
          stuck_order_minutes?: number
          updated_at?: string
          velocity_new_max?: number
          velocity_standard_after_days?: number
          velocity_trusted_after_days?: number
          velocity_trusted_after_paid_orders?: number
          velocity_trusted_max?: number
        }
        Update: {
          auto_refund_daily_max_kobo?: number
          auto_refund_max_kobo?: number
          float_alert_usd?: number
          id?: boolean
          max_domains_per_account_day?: number
          refund_delay_minutes?: number
          stuck_order_minutes?: number
          updated_at?: string
          velocity_new_max?: number
          velocity_standard_after_days?: number
          velocity_trusted_after_days?: number
          velocity_trusted_after_paid_orders?: number
          velocity_trusted_max?: number
        }
        Relationships: []
      }
      order_item_costs: {
        Row: {
          icann_fee_cents: number
          order_item_id: string
          recorded_at: string
          supplier_cost_cents: number
        }
        Insert: {
          icann_fee_cents: number
          order_item_id: string
          recorded_at?: string
          supplier_cost_cents: number
        }
        Update: {
          icann_fee_cents?: number
          order_item_id?: string
          recorded_at?: string
          supplier_cost_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_item_costs_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: true
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          auto_renew: boolean
          created_at: string
          domain: string
          domain_id: string | null
          failure_code: string | null
          id: string
          item_type: string
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_id: string
          period_years: number
          price_kobo: number
          privacy: boolean
          renewal_kobo: number
          renewal_years: number
          ssl_product_code: string | null
          status: Database["public"]["Enums"]["order_item_status"]
          tld: string
          updated_at: string
        }
        Insert: {
          auto_renew: boolean
          created_at?: string
          domain: string
          domain_id?: string | null
          failure_code?: string | null
          id?: string
          item_type?: string
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_id: string
          period_years: number
          price_kobo: number
          privacy: boolean
          renewal_kobo: number
          renewal_years?: number
          ssl_product_code?: string | null
          status?: Database["public"]["Enums"]["order_item_status"]
          tld: string
          updated_at?: string
        }
        Update: {
          auto_renew?: boolean
          created_at?: string
          domain?: string
          domain_id?: string | null
          failure_code?: string | null
          id?: string
          item_type?: string
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_id?: string
          period_years?: number
          price_kobo?: number
          privacy?: boolean
          renewal_kobo?: number
          renewal_years?: number
          ssl_product_code?: string | null
          status?: Database["public"]["Enums"]["order_item_status"]
          tld?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_nameserver_preset_id_fkey"
            columns: ["nameserver_preset_id"]
            isOneToOne: false
            referencedRelation: "nameserver_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_ssl_product_code_fkey"
            columns: ["ssl_product_code"]
            isOneToOne: false
            referencedRelation: "ssl_products"
            referencedColumns: ["product_code"]
          },
        ]
      }
      orders: {
        Row: {
          contact_profile_id: string | null
          contacts: Json | null
          created_at: string
          float_check: string
          fx_rate_id: string
          id: string
          invoice_number: string | null
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_number: string
          paid_at: string | null
          payment_checked_at: string | null
          payment_id: string | null
          registrant: Json
          status: Database["public"]["Enums"]["order_status"]
          subtotal_kobo: number
          test_mode: boolean
          total_kobo: number
          tx_ref: string
          updated_at: string
          user_id: string
          vat_kobo: number
          vat_pct: number
        }
        Insert: {
          contact_profile_id?: string | null
          contacts?: Json | null
          created_at?: string
          float_check: string
          fx_rate_id: string
          id?: string
          invoice_number?: string | null
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_number?: string
          paid_at?: string | null
          payment_checked_at?: string | null
          payment_id?: string | null
          registrant: Json
          status?: Database["public"]["Enums"]["order_status"]
          subtotal_kobo: number
          test_mode: boolean
          total_kobo: number
          tx_ref: string
          updated_at?: string
          user_id: string
          vat_kobo: number
          vat_pct: number
        }
        Update: {
          contact_profile_id?: string | null
          contacts?: Json | null
          created_at?: string
          float_check?: string
          fx_rate_id?: string
          id?: string
          invoice_number?: string | null
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_number?: string
          paid_at?: string | null
          payment_checked_at?: string | null
          payment_id?: string | null
          registrant?: Json
          status?: Database["public"]["Enums"]["order_status"]
          subtotal_kobo?: number
          test_mode?: boolean
          total_kobo?: number
          tx_ref?: string
          updated_at?: string
          user_id?: string
          vat_kobo?: number
          vat_pct?: number
        }
        Relationships: [
          {
            foreignKeyName: "orders_contact_profile_id_fkey"
            columns: ["contact_profile_id"]
            isOneToOne: false
            referencedRelation: "contact_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_fx_rate_id_fkey"
            columns: ["fx_rate_id"]
            isOneToOne: false
            referencedRelation: "fx_rates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_nameserver_preset_id_fkey"
            columns: ["nameserver_preset_id"]
            isOneToOne: false
            referencedRelation: "nameserver_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_incidents: {
        Row: {
          created_at: string
          detail: Json
          id: number
          kind: string
          order_id: string | null
          provider_reference: string | null
          resolved_at: string | null
          resolved_by: string | null
          test_mode: boolean
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: number
          kind: string
          order_id?: string | null
          provider_reference?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          test_mode: boolean
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: number
          kind?: string
          order_id?: string | null
          provider_reference?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          test_mode?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "payment_incidents_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_kobo: number
          created_at: string
          currency: string
          id: string
          method: string | null
          order_id: string
          provider: string
          provider_reference: string
          raw: Json
          status: string
          tx_ref: string
          user_id: string
        }
        Insert: {
          amount_kobo: number
          created_at?: string
          currency: string
          id?: string
          method?: string | null
          order_id: string
          provider: string
          provider_reference: string
          raw: Json
          status: string
          tx_ref: string
          user_id: string
        }
        Update: {
          amount_kobo?: number
          created_at?: string
          currency?: string
          id?: string
          method?: string | null
          order_id?: string
          provider?: string
          provider_reference?: string
          raw?: Json
          status?: string
          tx_ref?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_settings: {
        Row: {
          fx_buffer_pct: number
          fx_move_threshold_pct: number
          icann_fee_usd: number
          id: boolean
          margin_ngn: number
          updated_at: string
          updated_by: string | null
          vat_pct: number
        }
        Insert: {
          fx_buffer_pct?: number
          fx_move_threshold_pct?: number
          icann_fee_usd?: number
          id?: boolean
          margin_ngn: number
          updated_at?: string
          updated_by?: string | null
          vat_pct?: number
        }
        Update: {
          fx_buffer_pct?: number
          fx_move_threshold_pct?: number
          icann_fee_usd?: number
          id?: boolean
          margin_ngn?: number
          updated_at?: string
          updated_by?: string | null
          vat_pct?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          business_name: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          kyc_status: string
          password_reset_at: string | null
          phone: string | null
          risk_score: number
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"]
          business_name?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          kyc_status?: string
          password_reset_at?: string | null
          phone?: string | null
          risk_score?: number
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          business_name?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          kyc_status?: string
          password_reset_at?: string | null
          phone?: string | null
          risk_score?: number
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          hits: number
          key: string
          window_start: string
        }
        Insert: {
          hits?: number
          key: string
          window_start: string
        }
        Update: {
          hits?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      reconcile_runs: {
        Row: {
          domains_seen: number | null
          error: string | null
          findings: number | null
          finished_at: string | null
          id: string
          started_at: string
          test_mode: boolean
        }
        Insert: {
          domains_seen?: number | null
          error?: string | null
          findings?: number | null
          finished_at?: string | null
          id?: string
          started_at?: string
          test_mode: boolean
        }
        Update: {
          domains_seen?: number | null
          error?: string | null
          findings?: number | null
          finished_at?: string | null
          id?: string
          started_at?: string
          test_mode?: boolean
        }
        Relationships: []
      }
      refund_events: {
        Row: {
          actor: string
          created_at: string
          detail: Json
          event: string
          id: number
          refund_id: string
        }
        Insert: {
          actor?: string
          created_at?: string
          detail?: Json
          event: string
          id?: number
          refund_id: string
        }
        Update: {
          actor?: string
          created_at?: string
          detail?: Json
          event?: string
          id?: number
          refund_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "refund_events_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "refunds"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount_kobo: number
          approved_at: string | null
          approved_by: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          failed_provider_refund_ids: string[]
          id: string
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          order_id: string
          order_item_id: string | null
          payment_id: string
          provider_called_at: string | null
          provider_refund_id: string | null
          provider_status: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          run_after: string
          status: Database["public"]["Enums"]["refund_status"]
          submitted_at: string | null
          test_mode: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_kobo: number
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          failed_provider_refund_ids?: string[]
          id?: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          order_id: string
          order_item_id?: string | null
          payment_id: string
          provider_called_at?: string | null
          provider_refund_id?: string | null
          provider_status?: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          run_after?: string
          status?: Database["public"]["Enums"]["refund_status"]
          submitted_at?: string | null
          test_mode: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_kobo?: number
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          failed_provider_refund_ids?: string[]
          id?: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          order_id?: string
          order_item_id?: string | null
          payment_id?: string
          provider_called_at?: string | null
          provider_refund_id?: string | null
          provider_status?: string | null
          reason?: Database["public"]["Enums"]["refund_reason"]
          run_after?: string
          status?: Database["public"]["Enums"]["refund_status"]
          submitted_at?: string | null
          test_mode?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      registry_drift: {
        Row: {
          detail: Json
          domain_id: string | null
          domain_name: string
          first_seen_at: string
          id: number
          kind: string
          last_run_id: string | null
          last_seen_at: string
          resolved_at: string | null
          test_mode: boolean
        }
        Insert: {
          detail?: Json
          domain_id?: string | null
          domain_name: string
          first_seen_at?: string
          id?: number
          kind: string
          last_run_id?: string | null
          last_seen_at?: string
          resolved_at?: string | null
          test_mode: boolean
        }
        Update: {
          detail?: Json
          domain_id?: string | null
          domain_name?: string
          first_seen_at?: string
          id?: number
          kind?: string
          last_run_id?: string | null
          last_seen_at?: string
          resolved_at?: string | null
          test_mode?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "registry_drift_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "registry_drift_last_run_id_fkey"
            columns: ["last_run_id"]
            isOneToOne: false
            referencedRelation: "reconcile_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      service_heartbeats: {
        Row: {
          beat_at: string
          detail: Json
          name: string
          test_mode: boolean
        }
        Insert: {
          beat_at?: string
          detail?: Json
          name: string
          test_mode: boolean
        }
        Update: {
          beat_at?: string
          detail?: Json
          name?: string
          test_mode?: boolean
        }
        Relationships: []
      }
      ssl_certificates: {
        Row: {
          approver_email: string | null
          ca_bundle_pem: string | null
          certificate_pem: string | null
          common_name: string
          configured_at: string | null
          contact: Json | null
          created_at: string
          csr: string | null
          expires_at: string | null
          id: string
          included_names: number
          is_wildcard: boolean
          issued_at: string | null
          last_checked_at: string | null
          last_error_code: string | null
          next_check_at: string | null
          order_item_id: string
          product_code: string
          product_name: string
          purchased_at: string | null
          reissue_count: number
          san_names: string[]
          status: string
          status_unrecognised_since: string | null
          subscription_ends_at: string | null
          supplier_certificate_id: string | null
          supplier_status: string | null
          test_mode: boolean
          updated_at: string
          user_id: string
          validation_method: string | null
          web_server: string | null
        }
        Insert: {
          approver_email?: string | null
          ca_bundle_pem?: string | null
          certificate_pem?: string | null
          common_name: string
          configured_at?: string | null
          contact?: Json | null
          created_at?: string
          csr?: string | null
          expires_at?: string | null
          id?: string
          included_names?: number
          is_wildcard?: boolean
          issued_at?: string | null
          last_checked_at?: string | null
          last_error_code?: string | null
          next_check_at?: string | null
          order_item_id: string
          product_code: string
          product_name: string
          purchased_at?: string | null
          reissue_count?: number
          san_names?: string[]
          status?: string
          status_unrecognised_since?: string | null
          subscription_ends_at?: string | null
          supplier_certificate_id?: string | null
          supplier_status?: string | null
          test_mode: boolean
          updated_at?: string
          user_id: string
          validation_method?: string | null
          web_server?: string | null
        }
        Update: {
          approver_email?: string | null
          ca_bundle_pem?: string | null
          certificate_pem?: string | null
          common_name?: string
          configured_at?: string | null
          contact?: Json | null
          created_at?: string
          csr?: string | null
          expires_at?: string | null
          id?: string
          included_names?: number
          is_wildcard?: boolean
          issued_at?: string | null
          last_checked_at?: string | null
          last_error_code?: string | null
          next_check_at?: string | null
          order_item_id?: string
          product_code?: string
          product_name?: string
          purchased_at?: string | null
          reissue_count?: number
          san_names?: string[]
          status?: string
          status_unrecognised_since?: string | null
          subscription_ends_at?: string | null
          supplier_certificate_id?: string | null
          supplier_status?: string | null
          test_mode?: boolean
          updated_at?: string
          user_id?: string
          validation_method?: string | null
          web_server?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ssl_certificates_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: true
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ssl_certificates_product_code_fkey"
            columns: ["product_code"]
            isOneToOne: false
            referencedRelation: "ssl_products"
            referencedColumns: ["product_code"]
          },
          {
            foreignKeyName: "ssl_certificates_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ssl_jobs: {
        Row: {
          attempts: number
          certificate_id: string
          created_at: string
          finished_at: string | null
          id: string
          idempotency_key: string
          kind: string
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          run_after: string
          sent_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          test_mode: boolean
          updated_at: string
        }
        Insert: {
          attempts?: number
          certificate_id: string
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key: string
          kind: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          run_after?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          test_mode: boolean
          updated_at?: string
        }
        Update: {
          attempts?: number
          certificate_id?: string
          created_at?: string
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          kind?: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          run_after?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          test_mode?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ssl_jobs_certificate_id_fkey"
            columns: ["certificate_id"]
            isOneToOne: false
            referencedRelation: "ssl_certificates"
            referencedColumns: ["id"]
          },
        ]
      }
      ssl_products: {
        Row: {
          create_usd: number | null
          created_at: string
          included_names: number | null
          is_multi_domain: boolean | null
          is_reissue_free: boolean | null
          is_sellable: boolean
          is_wildcard: boolean | null
          max_names: number | null
          name: string | null
          product_code: string
          requires_csr: boolean | null
          synced_at: string | null
          updated_at: string
          validation_type: string | null
          vendor: string | null
        }
        Insert: {
          create_usd?: number | null
          created_at?: string
          included_names?: number | null
          is_multi_domain?: boolean | null
          is_reissue_free?: boolean | null
          is_sellable?: boolean
          is_wildcard?: boolean | null
          max_names?: number | null
          name?: string | null
          product_code: string
          requires_csr?: boolean | null
          synced_at?: string | null
          updated_at?: string
          validation_type?: string | null
          vendor?: string | null
        }
        Update: {
          create_usd?: number | null
          created_at?: string
          included_names?: number | null
          is_multi_domain?: boolean | null
          is_reissue_free?: boolean | null
          is_sellable?: boolean
          is_wildcard?: boolean | null
          max_names?: number | null
          name?: string | null
          product_code?: string
          requires_csr?: boolean | null
          synced_at?: string | null
          updated_at?: string
          validation_type?: string | null
          vendor?: string | null
        }
        Relationships: []
      }
      supplier_balance_snapshots: {
        Row: {
          balance_usd: number
          id: number
          taken_at: string
          test_mode: boolean
        }
        Insert: {
          balance_usd: number
          id?: number
          taken_at?: string
          test_mode: boolean
        }
        Update: {
          balance_usd?: number
          id?: number
          taken_at?: string
          test_mode?: boolean
        }
        Relationships: []
      }
      supplier_calls: {
        Row: {
          created_at: string
          domain_name: string | null
          duration_ms: number
          environment: string
          error_code: string | null
          http_status: number | null
          id: number
          job_id: string | null
          message: string | null
          operation: string
          outcome: string
          ssl_job_id: string | null
        }
        Insert: {
          created_at?: string
          domain_name?: string | null
          duration_ms: number
          environment: string
          error_code?: string | null
          http_status?: number | null
          id?: number
          job_id?: string | null
          message?: string | null
          operation: string
          outcome: string
          ssl_job_id?: string | null
        }
        Update: {
          created_at?: string
          domain_name?: string | null
          duration_ms?: number
          environment?: string
          error_code?: string | null
          http_status?: number | null
          id?: number
          job_id?: string | null
          message?: string | null
          operation?: string
          outcome?: string
          ssl_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "supplier_calls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_calls_ssl_job_id_fkey"
            columns: ["ssl_job_id"]
            isOneToOne: false
            referencedRelation: "ssl_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_ledger_entries: {
        Row: {
          balance_cents: number
          charge_type: number
          delta_cents: number | null
          description: string
          match_call_id: number | null
          match_operation: string | null
          match_order_item_id: string | null
          match_state: string
          matched_at: string | null
          occurred_at: string
          old_balance_cents: number
          period: number | null
          product_id: string | null
          product_type: number
          recorded_at: string
          status: number
          test_mode: boolean
          trace_id: string
          type: number
        }
        Insert: {
          balance_cents: number
          charge_type: number
          delta_cents?: never
          description?: string
          match_call_id?: number | null
          match_operation?: string | null
          match_order_item_id?: string | null
          match_state?: string
          matched_at?: string | null
          occurred_at: string
          old_balance_cents: number
          period?: number | null
          product_id?: string | null
          product_type: number
          recorded_at?: string
          status: number
          test_mode: boolean
          trace_id: string
          type: number
        }
        Update: {
          balance_cents?: number
          charge_type?: number
          delta_cents?: never
          description?: string
          match_call_id?: number | null
          match_operation?: string | null
          match_order_item_id?: string | null
          match_state?: string
          matched_at?: string | null
          occurred_at?: string
          old_balance_cents?: number
          period?: number | null
          product_id?: string | null
          product_type?: number
          recorded_at?: string
          status?: number
          test_mode?: boolean
          trace_id?: string
          type?: number
        }
        Relationships: []
      }
      supplier_ledger_revisions: {
        Row: {
          applied: boolean
          changes: Json
          id: number
          seen_at: string
          test_mode: boolean
          trace_id: string
        }
        Insert: {
          applied: boolean
          changes: Json
          id?: never
          seen_at?: string
          test_mode: boolean
          trace_id: string
        }
        Update: {
          applied?: boolean
          changes?: Json
          id?: never
          seen_at?: string
          test_mode?: boolean
          trace_id?: string
        }
        Relationships: []
      }
      tlds: {
        Row: {
          featured_rank: number | null
          featured_tagline: string | null
          is_country_code: boolean
          is_paused: boolean
          is_sellable: boolean
          is_transferable: boolean | null
          max_chars: number | null
          max_period: number
          min_chars: number | null
          min_period: number
          name: string
          paused_reason: string | null
          redemption_days: number
          register_periods: number[] | null
          register_usd: number
          renew_periods: number[] | null
          renew_usd: number
          requires_extra_fields: boolean
          restore_usd: number | null
          synced_at: string
          transfer_usd: number | null
        }
        Insert: {
          featured_rank?: number | null
          featured_tagline?: string | null
          is_country_code?: boolean
          is_paused?: boolean
          is_sellable?: boolean
          is_transferable?: boolean | null
          max_chars?: number | null
          max_period?: number
          min_chars?: number | null
          min_period?: number
          name: string
          paused_reason?: string | null
          redemption_days?: number
          register_periods?: number[] | null
          register_usd: number
          renew_periods?: number[] | null
          renew_usd: number
          requires_extra_fields?: boolean
          restore_usd?: number | null
          synced_at?: string
          transfer_usd?: number | null
        }
        Update: {
          featured_rank?: number | null
          featured_tagline?: string | null
          is_country_code?: boolean
          is_paused?: boolean
          is_sellable?: boolean
          is_transferable?: boolean | null
          max_chars?: number | null
          max_period?: number
          min_chars?: number | null
          min_period?: number
          name?: string
          paused_reason?: string | null
          redemption_days?: number
          register_periods?: number[] | null
          register_usd?: number
          renew_periods?: number[] | null
          renew_usd?: number
          requires_extra_fields?: boolean
          restore_usd?: number | null
          synced_at?: string
          transfer_usd?: number | null
        }
        Relationships: []
      }
      transfer_secrets: {
        Row: {
          auth_code: string
          created_at: string
          order_item_id: string
        }
        Insert: {
          auth_code: string
          created_at?: string
          order_item_id: string
        }
        Update: {
          auth_code?: string
          created_at?: string
          order_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transfer_secrets_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: true
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      admin_compliance_notices_v: {
        Row: {
          channel: string | null
          checked_at: string | null
          delivery_status: string | null
          domain_id: string | null
          domain_name: string | null
          expires_at: string | null
          id: string | null
          masked_recipient: string | null
          notice_type: string | null
          sent_at: string | null
          template_version: string | null
          test_mode: boolean | null
          user_id: string | null
          window: string | null
        }
        Relationships: []
      }
      admin_domains_v: {
        Row: {
          auto_renew: boolean | null
          created_at: string | null
          deep_checked_at: string | null
          delegation_checked_at: string | null
          delegation_status: Database["public"]["Enums"]["delegation_status"] | null
          domain_name: string | null
          expires_at: string | null
          id: string | null
          local_status: Database["public"]["Enums"]["domain_status"] | null
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_item_id: string | null
          pending_nameservers: string[] | null
          pending_privacy: boolean | null
          pending_transfer_lock: boolean | null
          previous_nameservers: string[] | null
          privacy_enabled: boolean | null
          registered_at: string | null
          registrant_country: string | null
          registrant_type: string | null
          registry_checked_at: string | null
          registry_renewal_mode: string | null
          registry_status: string | null
          source: string | null
          test_mode: boolean | null
          tld: string | null
          transfer_lock: boolean | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      admin_email_outbox_v: {
        Row: {
          attempts: number | null
          category: string | null
          complained_at: string | null
          created_at: string | null
          delivery_status: string | null
          domain_id: string | null
          id: string | null
          kind: string | null
          last_error_safe: string | null
          masked_to: string | null
          next_attempt_at: string | null
          order_id: string | null
          sent_at: string | null
          skip_reason: string | null
          status: string | null
          template_version: string | null
          test_mode: boolean | null
          user_id: string | null
        }
        Relationships: []
      }
      admin_orders_v: {
        Row: {
          created_at: string | null
          float_check: string | null
          fx_rate_id: string | null
          id: string | null
          invoice_number: string | null
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_number: string | null
          paid_at: string | null
          payment_checked_at: string | null
          payment_id: string | null
          status: Database["public"]["Enums"]["order_status"] | null
          subtotal_kobo: number | null
          test_mode: boolean | null
          total_kobo: number | null
          tx_ref: string | null
          updated_at: string | null
          user_id: string | null
          vat_kobo: number | null
          vat_pct: number | null
        }
        Relationships: []
      }
      admin_payments_v: {
        Row: {
          absorbed: boolean | null
          amount_kobo: number | null
          charged_kobo: number | null
          created_at: string | null
          fee_kobo: number | null
          id: string | null
          method: string | null
          order_id: string | null
          provider_reference: string | null
          status: string | null
          test_mode: boolean | null
        }
        Relationships: []
      }
      admin_ssl_certificates_v: {
        Row: {
          approver_masked: string | null
          ca_bundle_pem: string | null
          certificate_pem: string | null
          common_name: string | null
          configured_at: string | null
          created_at: string | null
          expires_at: string | null
          id: string | null
          included_names: number | null
          is_wildcard: boolean | null
          issued_at: string | null
          last_checked_at: string | null
          last_error_code: string | null
          next_check_at: string | null
          order_item_id: string | null
          product_code: string | null
          product_name: string | null
          purchased_at: string | null
          reissue_count: number | null
          san_names: string[] | null
          status: string | null
          status_unrecognised_since: string | null
          subscription_ends_at: string | null
          supplier_certificate_id: string | null
          supplier_status: string | null
          test_mode: boolean | null
          updated_at: string | null
          user_id: string | null
          validation_method: string | null
          web_server: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      account_domain_allowance: {
        Args: { p_test_mode?: boolean; p_user_id: string }
        Returns: Json
      }
      activate_fx_rate: {
        Args: { actor?: string; rate_id: string }
        Returns: {
          base: string
          buffer_pct: number
          buy_rate: number
          costing_rate: number
          created_at: string
          effective_from: string | null
          id: string
          move_pct: number | null
          quote: string
          quoted_at: string
          raw_payload: Json | null
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          sell_rate: number
          source: Database["public"]["Enums"]["fx_source"]
          status: Database["public"]["Enums"]["fx_status"]
        }
        SetofOptions: {
          from: "*"
          to: "fx_rates"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      admin_activate_fx_rate: {
        Args: { p_rate_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_alert_conditions: {
        Args: { p_test_mode: boolean }
        Returns: {
          key: string
          kind: string
          severity: string
          summary: string
        }[]
      }
      admin_alert_stats: {
        Args: { p_days: number; p_test_mode: boolean }
        Returns: Json
      }
      admin_approve_refund: {
        Args: { p_reason: string; p_refund_id: string; p_request_key: string }
        Returns: Json
      }
      admin_attention_counts: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_cancel_refund: {
        Args: {
          p_checked_provider: boolean
          p_no_money_moved: boolean
          p_note: string
          p_refund_id: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_claim_note: {
        Args: {
          p_action: string
          p_audit_id: number
          p_label: string
          p_side: string
          p_target_id: string
        }
        Returns: Json
      }
      admin_correct_float_topup: {
        Args: {
          p_ngn_paid_kobo: number
          p_reason: string
          p_reference: string
          p_request_key: string
          p_topup_id: number
        }
        Returns: Json
      }
      admin_customer: {
        Args: { p_test_mode: boolean; p_user_id: string }
        Returns: Json
      }
      admin_customer_stats: { Args: never; Returns: Json }
      admin_customers: {
        Args: {
          p_dir: string
          p_filter: Json
          p_limit: number
          p_offset: number
          p_sort: string
          p_test_mode: boolean
        }
        Returns: {
          account_type: string
          domains_held: number
          email_confirmed: boolean
          has_totp: boolean
          is_admin: boolean
          joined_at: string
          last_sign_in_at: string
          masked_email: string
          orders_paid: number
          total_count: number
          total_paid_kobo: number
          user_id: string
        }[]
      }
      admin_discard_preset_draft: {
        Args: { p_draft_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_domain_stats: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_email_stats: {
        Args: { p_days: number; p_test_mode: boolean }
        Returns: Json
      }
      admin_fail_job: {
        Args: { p_job_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_fail_ssl_job: {
        Args: { p_job_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_find_customers: { Args: { p_query: string }; Returns: Json }
      admin_float: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_flw_check_done: {
        Args: {
          p_check: Database["public"]["Tables"]["flw_refund_checks"]["Row"]
        }
        Returns: boolean
      }
      admin_funnel: {
        Args: { p_from: string; p_test_mode: boolean; p_to: string }
        Returns: Json
      }
      admin_gate: {
        Args: {
          p_action: string
          p_admin: Database["public"]["Tables"]["admins"]["Row"]
          p_target_ok_for_test: boolean
        }
        Returns: string
      }
      admin_json_number: {
        Args: { p_scale: number; p_value: Json }
        Returns: number
      }
      admin_ledger_daily: {
        Args: { p_from: string; p_test_mode: boolean; p_to: string }
        Returns: {
          close_cents: number
          credit_cents: number
          day: string
          debit_cents: number
        }[]
      }
      admin_list_admins: {
        Args: never
        Returns: {
          added_at: string
          label: string
          last_change_at: string
          pinned_factors: number
          revoked_at: string
          role: string
          test_only: boolean
          verified_pinned_factors: number
        }[]
      }
      admin_lookup_rate_limited: {
        Args: { p_admin_id: string }
        Returns: boolean
      }
      admin_margin: {
        Args: { p_from: string; p_test_mode: boolean; p_to: string }
        Returns: {
          cost_kobo: number
          cost_source: string
          cost_topup_kobo: number
          costed_lines: number
          item_type: string
          lines: number
          margin_kobo: number
          month: string
          revenue_kobo: number
          row_kind: string
        }[]
      }
      admin_mask_email: { Args: { p_email: string }; Returns: string }
      admin_note: {
        Args: {
          p_action: string
          p_detail?: Json
          p_reason?: string
          p_request_key?: string
          p_side: string
          p_target_id: string
          p_target_type: string
        }
        Returns: Json
      }
      admin_note_result: {
        Args: {
          p_audit_id: number
          p_code: string
          p_detail: Json
          p_outcome: string
        }
        Returns: number
      }
      admin_overview: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_preset_usage: {
        Args: { p_test_mode: boolean }
        Returns: {
          domains: number
          lines: number
          orders: number
          preset_id: string
        }[]
      }
      admin_pricing_status: { Args: never; Returns: Json }
      admin_provisioning: {
        Args: { p_from: string; p_test_mode: boolean; p_to: string }
        Returns: Json
      }
      admin_publish_preset_draft: {
        Args: { p_draft_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_queue_deep_sync: {
        Args: { p_domain_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_read_gate: {
        Args: { p_test_mode: boolean }
        Returns: {
          added_at: string
          added_by: string
          label: string
          mfa_factor_ids: string[]
          revoked_at: string | null
          role: string
          test_only: boolean
          user_id: string
        }
      }
      admin_reason_problem: { Args: { p_reason: string }; Returns: string }
      admin_record: {
        Args: {
          p_action: string
          p_admin: Database["public"]["Tables"]["admins"]["Row"]
          p_code: string
          p_detail: Json
          p_error: string
          p_outcome: string
          p_parent_id?: number
          p_reason: string
          p_request_key: string
          p_side: string
          p_target_id: string
          p_target_test_mode: boolean
          p_target_type: string
        }
        Returns: Json
      }
      admin_record_float_topup: {
        Args: {
          p_ngn_paid_kobo: number
          p_reason: string
          p_reference: string
          p_request_key: string
          p_trace_id: string
        }
        Returns: Json
      }
      admin_record_manual_refund: {
        Args: {
          p_check_id: number
          p_checked_provider: boolean
          p_provider_refund_id: string
          p_reason: string
          p_refund_id: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_redact_reason: {
        Args: { p_audit_id: number; p_request_key: string; p_why: string }
        Returns: Json
      }
      admin_refund_stats: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_reject_fx_rate: {
        Args: { p_rate_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_replay: {
        Args: {
          p_action: string
          p_admin_id: string
          p_request_key: string
          p_target_id: string
        }
        Returns: Json
      }
      admin_requeue_email: {
        Args: { p_email_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_resolve_payment_incident: {
        Args: {
          p_check_id: number
          p_confirmed: boolean
          p_incident_id: number
          p_outcome: string
          p_reason: string
          p_refund_id: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_retry_job: {
        Args: { p_job_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_retry_refund: {
        Args: {
          p_checked_provider: boolean
          p_reason: string
          p_refund_id: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_retry_ssl_job: {
        Args: { p_job_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_reveal_customer: {
        Args: { p_reason: string; p_request_key: string; p_user_id: string }
        Returns: Json
      }
      admin_reveal_registrant: {
        Args: { p_domain_id: string; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_revenue: {
        Args: {
          p_from: string
          p_grain: string
          p_test_mode: boolean
          p_to: string
        }
        Returns: {
          bucket: string
          cash_kobo: number
          charge_refunded_kobo: number
          fee_absorbed_kobo: number
          fee_kobo: number
          line_refunded_kobo: number
          line_refunded_vat_kobo: number
          net_kobo: number
          orders: number
          vat_kobo: number
        }[]
      }
      admin_sales_since: {
        Args: { p_since: string; p_test_mode: boolean }
        Returns: Json
      }
      admin_save_preset_draft: {
        Args: {
          p_assigns_per_zone: boolean
          p_nameservers: string[]
          p_notes: string
          p_preset_id: string
          p_provider: string
          p_reason: string
          p_request_key: string
          p_source_url: string
        }
        Returns: Json
      }
      admin_session: {
        Args: {
          p_check_hold?: boolean
          p_fresh_minutes?: number
          p_min_role?: string
        }
        Returns: {
          added_at: string
          added_by: string
          label: string
          mfa_factor_ids: string[]
          revoked_at: string | null
          role: string
          test_only: boolean
          user_id: string
        }
      }
      admin_set_preset_hidden: {
        Args: {
          p_hidden: boolean
          p_id: string
          p_reason: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_set_ssl_sellable: {
        Args: {
          p_product_code: string
          p_reason: string
          p_request_key: string
          p_sellable: boolean
        }
        Returns: Json
      }
      admin_set_tld_flags: {
        Args: {
          p_featured_rank: number
          p_featured_tagline: string
          p_is_paused: boolean
          p_name: string
          p_paused_reason: string
          p_reason: string
          p_request_key: string
        }
        Returns: Json
      }
      admin_ssl_stats: { Args: { p_test_mode: boolean }; Returns: Json }
      admin_status: { Args: never; Returns: string }
      admin_tier: {
        Args: { p_action: string }
        Returns: {
          min_role: string
          money: boolean
          test_rule: string
        }
      }
      admin_tld_held_counts: {
        Args: { p_test_mode: boolean }
        Returns: {
          held: number
          tld: string
        }[]
      }
      admin_update_ops_settings: {
        Args: { p_changes: Json; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_update_pricing_settings: {
        Args: { p_changes: Json; p_reason: string; p_request_key: string }
        Returns: Json
      }
      admin_url_host: { Args: { p_url: string }; Returns: string }
      admin_whoami: { Args: { p_fresh_minutes?: number }; Returns: Json }
      approve_refund: {
        Args: { p_by: string; p_refund_id: string }
        Returns: undefined
      }
      are_hostnames: { Args: { p_hosts: string[] }; Returns: boolean }
      are_sold_periods: { Args: { p_periods: number[] }; Returns: boolean }
      begin_reconcile: {
        Args: { p_min_interval_seconds: number; p_test_mode: boolean }
        Returns: string
      }
      bump_funnel: {
        Args: { p_event: string; p_test_mode: boolean }
        Returns: undefined
      }
      cancel_refund: {
        Args: { p_by: string; p_note: string; p_refund_id: string }
        Returns: undefined
      }
      claim_emails: {
        Args: { p_limit?: number; p_test_mode: boolean; p_worker: string }
        Returns: {
          attempts: number
          category: string
          data: Json
          domain_id: string
          id: string
          kind: string
          order_id: string
          test_mode: boolean
          to_email: string
          user_id: string
        }[]
      }
      claim_job: {
        Args: {
          p_job_id?: string
          p_lease_seconds?: number
          p_test_mode: boolean
          p_worker: string
        }
        Returns: Json
      }
      claim_refund: {
        Args: {
          p_lease_seconds?: number
          p_test_mode: boolean
          p_worker: string
        }
        Returns: Json
      }
      claim_ssl_job: {
        Args: {
          p_job_id?: string
          p_lease_seconds?: number
          p_test_mode: boolean
          p_worker: string
        }
        Returns: Json
      }
      claimed_refund: {
        Args: { p_refund_id: string; p_worker: string }
        Returns: {
          amount_kobo: number
          approved_at: string | null
          approved_by: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          failed_provider_refund_ids: string[]
          id: string
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          order_id: string
          order_item_id: string | null
          payment_id: string
          provider_called_at: string | null
          provider_refund_id: string | null
          provider_status: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          run_after: string
          status: Database["public"]["Enums"]["refund_status"]
          submitted_at: string | null
          test_mode: boolean
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "refunds"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_refund: {
        Args: {
          p_provider_refund_id: string
          p_provider_status: string
          p_refund_id: string
          p_worker: string
        }
        Returns: undefined
      }
      complete_registration: {
        Args: {
          p_expires_at: string
          p_job_id: string
          p_nameserver_code?: string
          p_nameserver_result: string
          p_nameservers: string[]
          p_privacy: boolean
          p_recovered: boolean
          p_registered_at: string
          p_transfer_lock: boolean
        }
        Returns: Database["public"]["Enums"]["domain_status"]
      }
      complete_renewal: {
        Args: { p_expires_at: string; p_job_id: string; p_recovered: boolean }
        Returns: undefined
      }
      complete_ssl_initialize: {
        Args: {
          p_job_id: string
          p_purchased_at: string
          p_recovered: boolean
          p_subscription_ends_at: string
          p_supplier_id: string
          p_supplier_status: string
        }
        Returns: undefined
      }
      complete_transfer: {
        Args: {
          p_expires_at: string
          p_job_id: string
          p_nameservers: string[]
          p_privacy: boolean
          p_recovered: boolean
          p_registered_at: string
          p_transfer_lock: boolean
        }
        Returns: undefined
      }
      cron_alert_conditions: {
        Args: { p_test_mode: boolean }
        Returns: {
          key: string
          kind: string
          severity: string
          summary: string
        }[]
      }
      current_alert_conditions: {
        Args: { p_test_mode: boolean }
        Returns: {
          key: string
          kind: string
          severity: string
          summary: string
        }[]
      }
      domains_for_deep_sync: {
        Args: { p_limit?: number; p_test_mode: boolean }
        Returns: {
          auto_renew: boolean
          domain_id: string
          domain_name: string
          expires_at: string
          local_status: string
          nameservers: string[]
          pending_nameservers: string[]
          privacy: boolean
          transfer_lock: boolean
        }[]
      }
      domains_for_delegation_check: {
        Args: { p_every_hours?: number; p_limit?: number }
        Returns: {
          delegation_status: Database["public"]["Enums"]["delegation_status"]
          domain_id: string
          domain_name: string
          nameservers: string[]
        }[]
      }
      emails_for_delivery_check: {
        Args: { p_limit?: number }
        Returns: {
          id: string
          provider_message_id: string
          sent_at: string
        }[]
      }
      enqueue_domain_change: {
        Args: {
          p_domain_id: string
          p_kind: Database["public"]["Enums"]["job_kind"]
        }
        Returns: undefined
      }
      enqueue_expiry_notices: { Args: never; Returns: number }
      enqueue_line_refund: {
        Args: { p_order_item_id: string }
        Returns: string
      }
      enqueue_nameserver_change: {
        Args: { p_domain_id: string }
        Returns: undefined
      }
      enqueue_refund: {
        Args: {
          p_amount_kobo: number
          p_delay_minutes?: number
          p_order_id: string
          p_order_item_id: string
          p_payment_id: string
          p_reason: Database["public"]["Enums"]["refund_reason"]
        }
        Returns: string
      }
      enqueue_undelegated_nudges: { Args: never; Returns: number }
      expire_unpaid_orders: { Args: { p_older_than?: string }; Returns: number }
      fail_job: {
        Args: {
          p_code: string
          p_job_id: string
          p_message: string
          p_needs_attention?: boolean
        }
        Returns: undefined
      }
      fail_reconcile: {
        Args: { p_error: string; p_run_id: string }
        Returns: undefined
      }
      fail_refund: {
        Args: {
          p_code: string
          p_message: string
          p_needs_attention: boolean
          p_provider_refund_id?: string
          p_refund_id: string
          p_worker: string
        }
        Returns: undefined
      }
      fail_ssl_job: {
        Args: {
          p_code: string
          p_job_id: string
          p_message: string
          p_needs_attention?: boolean
        }
        Returns: undefined
      }
      finish_refund: {
        Args: {
          p_actor: string
          p_provider_refund_id: string
          p_provider_status: string
          p_refund_id: string
        }
        Returns: undefined
      }
      float_runway: { Args: { p_test_mode: boolean }; Returns: Json }
      grant_test_admin: { Args: { p_user_id: string }; Returns: string }
      hold_test_refund: { Args: { p_refund_id: string }; Returns: undefined }
      is_reserved_email: { Args: { p_email: string }; Returns: boolean }
      ledger_alert_conditions: {
        Args: { p_test_mode: boolean }
        Returns: {
          key: string
          kind: string
          severity: string
          summary: string
        }[]
      }
      ledger_guid: {
        Args: { p_nullable: boolean; p_value: string }
        Returns: string
      }
      ledger_int: {
        Args: {
          p_key: string
          p_max: number
          p_min: number
          p_nullable: boolean
          p_row: Json
        }
        Returns: number
      }
      mark_alerts_notified: {
        Args: { p_alert_ids: number[]; p_resolved_ids: number[] }
        Returns: undefined
      }
      mark_email_failed: {
        Args: {
          p_error: string
          p_id: string
          p_permanent?: boolean
          p_worker: string
        }
        Returns: boolean
      }
      mark_email_sent: {
        Args: {
          p_id: string
          p_message_id: string
          p_template_version: string
          p_worker: string
        }
        Returns: boolean
      }
      mark_email_skipped: {
        Args: { p_id: string; p_reason: string; p_worker: string }
        Returns: boolean
      }
      mark_transfer_submitted: {
        Args: { p_job_id: string; p_poll_after_seconds?: number }
        Returns: undefined
      }
      match_supplier_ledger: { Args: { p_test_mode: boolean }; Returns: number }
      merge_anonymous_cart: {
        Args: { p_token_hash: string; p_user_id: string }
        Returns: number
      }
      my_bulk_operation: {
        Args: { p_operation_id: string }
        Returns: {
          domain_id: string
          domain_name: string
          job_error_code: string
          job_status: string
          outcome: string
          reason: string
        }[]
      }
      my_order_refunds: {
        Args: { p_order_id: string }
        Returns: {
          amount_kobo: number
          domain: string
          id: string
          reason: string
          refunded_at: string
          state: string
          test_mode: boolean
        }[]
      }
      my_sessions: {
        Args: never
        Returns: {
          aal: string
          created_at: string
          id: string
          ip: string
          is_current: boolean
          last_used_at: string
          user_agent: string
        }[]
      }
      note_refund_provider_call: {
        Args: { p_refund_id: string; p_worker: string }
        Returns: undefined
      }
      note_renewal_baseline: {
        Args: { p_expires_at: string; p_job_id: string }
        Returns: string
      }
      note_sign_in: {
        Args: { p_device: string; p_user_id: string }
        Returns: boolean
      }
      note_ssl_job_sent: { Args: { p_job_id: string }; Returns: string }
      orders_to_check: {
        Args: { p_limit: number; p_test_mode: boolean }
        Returns: {
          created_at: string
          id: string
          known_references: string[]
          order_number: string
          total_kobo: number
          tx_ref: string
        }[]
      }
      payment_record: { Args: { p_raw: Json }; Returns: Json }
      preset_drafts_for_check: {
        Args: never
        Returns: {
          draft_id: string
          nameservers: string[]
          provider: string
        }[]
      }
      presets_for_check: {
        Args: never
        Returns: {
          nameservers: string[]
          preset_id: string
          provider: string
        }[]
      }
      public_status: { Args: never; Returns: Json }
      purge_email_records: { Args: never; Returns: number }
      purge_stale_carts: { Args: { p_older_than?: string }; Returns: number }
      purge_supplier_calls: { Args: never; Returns: number }
      purge_test_admin_audit: { Args: never; Returns: number }
      purge_test_ledger_entries: { Args: never; Returns: number }
      purge_test_orders: { Args: { p_user_id: string }; Returns: undefined }
      queue_account_email: {
        Args: { p_kind: string; p_user_id: string }
        Returns: string
      }
      queue_email: {
        Args: {
          p_category: string
          p_data?: Json
          p_dedupe_key: string
          p_domain_id?: string
          p_kind: string
          p_order_id?: string
          p_test_mode?: boolean
          p_user_id: string
        }
        Returns: string
      }
      rate_limit_hit: {
        Args: { p_key: string; p_max: number; p_window_seconds: number }
        Returns: boolean
      }
      record_deep_sync: {
        Args: {
          p_domain_id: string
          p_findings?: Json
          p_test_mode: boolean
          p_update: Json
        }
        Returns: undefined
      }
      record_delegation_checks: { Args: { p_results: Json }; Returns: number }
      record_domain_change: {
        Args: {
          p_applied: Json
          p_attempted: Json
          p_code?: string
          p_job_id: string
        }
        Returns: undefined
      }
      record_email_delivery: {
        Args: { p_id: string; p_status: string }
        Returns: boolean
      }
      record_email_event: {
        Args: { p_detail?: Json; p_event: string; p_message_id: string }
        Returns: boolean
      }
      record_flw_refund_check: {
        Args: {
          p_amount_kobo: number
          p_audit_id: number
          p_currency: string
          p_disburse_status: string
          p_flw_refund_id: string
          p_state: string
          p_status: string
          p_target_id: string
          p_target_type: string
          p_test_mode: boolean
          p_tx_id: string
        }
        Returns: number
      }
      record_heartbeat: {
        Args: { p_detail: Json; p_name: string; p_test_mode: boolean }
        Returns: undefined
      }
      record_manual_refund: {
        Args: {
          p_by: string
          p_provider_refund_id: string
          p_refund_id: string
        }
        Returns: undefined
      }
      record_metrics_daily: { Args: { p_day: string }; Returns: undefined }
      record_nameserver_change: {
        Args: {
          p_applied: string[]
          p_attempted: string[]
          p_code?: string
          p_job_id: string
        }
        Returns: undefined
      }
      record_order_payment: {
        Args: {
          p_amount_kobo: number
          p_currency: string
          p_method: string
          p_order_id: string
          p_provider_reference: string
          p_raw: Json
        }
        Returns: Database["public"]["Enums"]["order_status"]
      }
      record_payment_incident: {
        Args: {
          p_detail: Json
          p_kind: string
          p_order_id: string
          p_provider_reference: string
        }
        Returns: undefined
      }
      record_preset_check: {
        Args: { p_detail?: Json; p_ok: boolean; p_preset_id: string }
        Returns: string
      }
      record_preset_draft_check: {
        Args: { p_detail: Json; p_draft_id: string; p_ok: boolean }
        Returns: string
      }
      record_reconciliation: {
        Args: {
          p_complete: boolean
          p_domains_seen: number
          p_findings: Json
          p_run_id: string
          p_updates: Json
        }
        Returns: number
      }
      record_refund_submitted: {
        Args: {
          p_check_after_seconds: number
          p_provider_refund_id: string
          p_provider_status: string
          p_refund_id: string
          p_worker: string
        }
        Returns: undefined
      }
      record_ssl_configured: {
        Args: {
          p_job_id: string
          p_recovered: boolean
          p_supplier_status: string
        }
        Returns: undefined
      }
      record_ssl_reissue: {
        Args: {
          p_job_id: string
          p_recovered: boolean
          p_state: string
          p_supplier_status: string
        }
        Returns: undefined
      }
      record_ssl_status: {
        Args: {
          p_ca_bundle: string
          p_certificate: string
          p_certificate_id: string
          p_expires_at: string
          p_issued_at: string
          p_next_check_seconds: number
          p_state: string
          p_supplier_status: string
        }
        Returns: string
      }
      record_supplier_balance: {
        Args: { p_balance_usd: number; p_test_mode: boolean }
        Returns: undefined
      }
      record_supplier_ledger: {
        Args: { p_rows: Json; p_test_mode: boolean }
        Returns: Json
      }
      record_underpayment: {
        Args: {
          p_amount_kobo: number
          p_currency: string
          p_method: string
          p_order_id: string
          p_provider_reference: string
          p_raw: Json
        }
        Returns: string
      }
      refund_hold_reason: {
        Args: {
          p_amount_kobo: number
          p_exclude_id: string
          p_test_mode: boolean
        }
        Returns: string
      }
      refuse_ssl_setup: {
        Args: { p_code: string; p_job_id: string; p_message: string }
        Returns: undefined
      }
      request_ssl_reissue: {
        Args: { p_certificate_id: string; p_user_id: string }
        Returns: string
      }
      request_ssl_setup: {
        Args: {
          p_approver_email: string
          p_certificate_id: string
          p_contact: Json
          p_csr: string
          p_san_names: string[]
          p_user_id: string
          p_web_server: string
        }
        Returns: string
      }
      reschedule_job: {
        Args: {
          p_code: string
          p_delay_seconds: number
          p_job_id: string
          p_message: string
        }
        Returns: undefined
      }
      reschedule_refund: {
        Args: {
          p_code: string
          p_delay_seconds: number
          p_message: string
          p_refund_id: string
          p_sent: boolean
          p_worker: string
        }
        Returns: undefined
      }
      reschedule_ssl_job: {
        Args: {
          p_code: string
          p_delay_seconds: number
          p_job_id: string
          p_message: string
        }
        Returns: undefined
      }
      resolve_payment_incident: {
        Args: { p_by: string; p_incident_id: number }
        Returns: undefined
      }
      retry_job: { Args: { p_job_id: string }; Returns: undefined }
      retry_refund: {
        Args: { p_by: string; p_refund_id: string }
        Returns: undefined
      }
      retry_ssl_job: { Args: { p_job_id: string }; Returns: undefined }
      revoke_my_session: { Args: { p_session_id: string }; Returns: boolean }
      same_nameservers: {
        Args: { p_a: string[]; p_b: string[] }
        Returns: boolean
      }
      seed_test_failed_email: { Args: { p_user_id: string }; Returns: string }
      settle_order: { Args: { p_order_id: string }; Returns: undefined }
      ssl_certificates_to_check: {
        Args: { p_limit?: number; p_test_mode: boolean }
        Returns: {
          common_name: string
          configured_at: string
          has_certificate: boolean
          id: string
          is_wildcard: boolean
          status: string
        }[]
      }
      ssl_name_in_use: {
        Args: { p_common_name: string; p_test_mode: boolean }
        Returns: boolean
      }
      start_bulk_change: {
        Args: {
          p_domain_ids: string[]
          p_kind: string
          p_user_id: string
          p_value: Json
        }
        Returns: string
      }
      sync_alerts: { Args: { p_test_mode: boolean }; Returns: Json }
      try_timestamptz: { Args: { p_value: string }; Returns: string }
    }
    Enums: {
      account_type: "individual" | "business"
      delegation_status: "undelegated" | "pending" | "verified" | "failed"
      domain_status:
        | "pending"
        | "active"
        | "expired_grace"
        | "redemption"
        | "pending_delete"
        | "released"
        | "transferred_away"
        | "pending_verification"
        | "transfer_requested"
        | "transfer_pending"
        | "transfer_rejected"
        | "transfer_cancelled"
        | "registration_failed"
        | "closed"
      fx_source:
        | "aboki-parallel"
        | "manual"
        | "official"
        | "er-api"
        | "currency-api"
      fx_status: "active" | "pending_review" | "superseded" | "rejected"
      job_kind:
        | "register_domain"
        | "apply_nameservers"
        | "renew_domain"
        | "transfer_domain"
        | "set_transfer_lock"
        | "set_privacy"
        | "update_contacts"
      job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "needs_attention"
      order_item_status:
        | "pending"
        | "provisioning"
        | "completed"
        | "failed"
        | "refunded"
      order_status:
        | "awaiting_payment"
        | "paid"
        | "provisioning"
        | "completed"
        | "partially_failed"
        | "failed"
        | "cancelled"
      refund_reason:
        | "registration_failed"
        | "duplicate_charge"
        | "overpayment"
        | "underpayment"
        | "empty_order"
        | "renewal_failed"
        | "transfer_failed"
        | "ssl_failed"
      refund_status:
        | "queued"
        | "held"
        | "sending"
        | "submitted"
        | "completed"
        | "failed"
        | "needs_attention"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_type: ["individual", "business"],
      delegation_status: ["undelegated", "pending", "verified", "failed"],
      domain_status: [
        "pending",
        "active",
        "expired_grace",
        "redemption",
        "pending_delete",
        "released",
        "transferred_away",
        "pending_verification",
        "transfer_requested",
        "transfer_pending",
        "transfer_rejected",
        "transfer_cancelled",
        "registration_failed",
        "closed",
      ],
      fx_source: [
        "aboki-parallel",
        "manual",
        "official",
        "er-api",
        "currency-api",
      ],
      fx_status: ["active", "pending_review", "superseded", "rejected"],
      job_kind: [
        "register_domain",
        "apply_nameservers",
        "renew_domain",
        "transfer_domain",
        "set_transfer_lock",
        "set_privacy",
        "update_contacts",
      ],
      job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "needs_attention",
      ],
      order_item_status: [
        "pending",
        "provisioning",
        "completed",
        "failed",
        "refunded",
      ],
      order_status: [
        "awaiting_payment",
        "paid",
        "provisioning",
        "completed",
        "partially_failed",
        "failed",
        "cancelled",
      ],
      refund_reason: [
        "registration_failed",
        "duplicate_charge",
        "overpayment",
        "underpayment",
        "empty_order",
        "renewal_failed",
        "transfer_failed",
        "ssl_failed",
      ],
      refund_status: [
        "queued",
        "held",
        "sending",
        "submitted",
        "completed",
        "failed",
        "needs_attention",
        "cancelled",
      ],
    },
  },
} as const
