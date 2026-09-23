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
      domains: {
        Row: {
          auto_renew: boolean
          created_at: string
          delegation_checked_at: string | null
          delegation_status: Database["public"]["Enums"]["delegation_status"]
          domain_name: string
          expires_at: string | null
          id: string
          local_status: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id: string | null
          nameservers: string[] | null
          order_item_id: string | null
          pending_nameservers: string[] | null
          privacy_enabled: boolean
          registered_at: string | null
          registrant: Json | null
          source: string
          test_mode: boolean
          tld: string
          transfer_lock: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_renew?: boolean
          created_at?: string
          delegation_checked_at?: string | null
          delegation_status?: Database["public"]["Enums"]["delegation_status"]
          domain_name: string
          expires_at?: string | null
          id?: string
          local_status?: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_item_id?: string | null
          pending_nameservers?: string[] | null
          privacy_enabled?: boolean
          registered_at?: string | null
          registrant?: Json | null
          source: string
          test_mode?: boolean
          tld: string
          transfer_lock?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_renew?: boolean
          created_at?: string
          delegation_checked_at?: string | null
          delegation_status?: Database["public"]["Enums"]["delegation_status"]
          domain_name?: string
          expires_at?: string | null
          id?: string
          local_status?: Database["public"]["Enums"]["domain_status"]
          nameserver_preset_id?: string | null
          nameservers?: string[] | null
          order_item_id?: string | null
          pending_nameservers?: string[] | null
          privacy_enabled?: boolean
          registered_at?: string | null
          registrant?: Json | null
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
          test_mode: boolean
          updated_at: string
        }
        Insert: {
          attempts?: number
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
          test_mode: boolean
          updated_at?: string
        }
        Update: {
          attempts?: number
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
      nameserver_presets: {
        Row: {
          assigns_per_zone: boolean
          created_at: string
          id: string
          is_hidden: boolean
          nameservers: string[]
          notes: string | null
          provider: string
          source_url: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          assigns_per_zone?: boolean
          created_at?: string
          id?: string
          is_hidden?: boolean
          nameservers?: string[]
          notes?: string | null
          provider: string
          source_url: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          assigns_per_zone?: boolean
          created_at?: string
          id?: string
          is_hidden?: boolean
          nameservers?: string[]
          notes?: string | null
          provider?: string
          source_url?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      order_items: {
        Row: {
          auto_renew: boolean
          created_at: string
          domain: string
          failure_code: string | null
          id: string
          item_type: string
          order_id: string
          period_years: number
          price_kobo: number
          privacy: boolean
          renewal_kobo: number
          status: Database["public"]["Enums"]["order_item_status"]
          tld: string
          updated_at: string
        }
        Insert: {
          auto_renew: boolean
          created_at?: string
          domain: string
          failure_code?: string | null
          id?: string
          item_type?: string
          order_id: string
          period_years: number
          price_kobo: number
          privacy: boolean
          renewal_kobo: number
          status?: Database["public"]["Enums"]["order_item_status"]
          tld: string
          updated_at?: string
        }
        Update: {
          auto_renew?: boolean
          created_at?: string
          domain?: string
          failure_code?: string | null
          id?: string
          item_type?: string
          order_id?: string
          period_years?: number
          price_kobo?: number
          privacy?: boolean
          renewal_kobo?: number
          status?: Database["public"]["Enums"]["order_item_status"]
          tld?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          contact_profile_id: string | null
          created_at: string
          float_check: string
          fx_rate_id: string
          id: string
          nameservers: string[] | null
          order_number: string
          paid_at: string | null
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
          created_at?: string
          float_check: string
          fx_rate_id: string
          id?: string
          nameservers?: string[] | null
          order_number?: string
          paid_at?: string | null
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
          created_at?: string
          float_check?: string
          fx_rate_id?: string
          id?: string
          nameservers?: string[] | null
          order_number?: string
          paid_at?: string | null
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
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
        }
        Relationships: [
          {
            foreignKeyName: "supplier_calls_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      tlds: {
        Row: {
          featured_rank: number | null
          featured_tagline: string | null
          is_country_code: boolean
          is_paused: boolean
          is_sellable: boolean
          max_period: number
          min_period: number
          name: string
          paused_reason: string | null
          redemption_days: number
          register_usd: number
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
          max_period?: number
          min_period?: number
          name: string
          paused_reason?: string | null
          redemption_days?: number
          register_usd: number
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
          max_period?: number
          min_period?: number
          name?: string
          paused_reason?: string | null
          redemption_days?: number
          register_usd?: number
          renew_usd?: number
          requires_extra_fields?: boolean
          restore_usd?: number | null
          synced_at?: string
          transfer_usd?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
      claim_job: {
        Args: {
          p_job_id?: string
          p_lease_seconds?: number
          p_test_mode: boolean
          p_worker: string
        }
        Returns: Json
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
      enqueue_nameserver_change: {
        Args: { p_domain_id: string }
        Returns: undefined
      }
      fail_job: {
        Args: {
          p_code: string
          p_job_id: string
          p_message: string
          p_needs_attention?: boolean
        }
        Returns: undefined
      }
      merge_anonymous_cart: {
        Args: { p_token_hash: string; p_user_id: string }
        Returns: number
      }
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
      reschedule_job: {
        Args: {
          p_code: string
          p_delay_seconds: number
          p_job_id: string
          p_message: string
        }
        Returns: undefined
      }
      retry_job: { Args: { p_job_id: string }; Returns: undefined }
      settle_order: { Args: { p_order_id: string }; Returns: undefined }
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
      job_kind: "register_domain" | "apply_nameservers"
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
      job_kind: ["register_domain", "apply_nameservers"],
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
    },
  },
} as const
