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
      merge_anonymous_cart: {
        Args: { p_token_hash: string; p_user_id: string }
        Returns: number
      }
    }
    Enums: {
      account_type: "individual" | "business"
      fx_source:
        | "aboki-parallel"
        | "manual"
        | "official"
        | "er-api"
        | "currency-api"
      fx_status: "active" | "pending_review" | "superseded" | "rejected"
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
      fx_source: [
        "aboki-parallel",
        "manual",
        "official",
        "er-api",
        "currency-api",
      ],
      fx_status: ["active", "pending_review", "superseded", "rejected"],
    },
  },
} as const
