/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate after every migration:
 *   pnpm db:types
 *
 * Until the first migration is applied this is a permissive placeholder so the
 * workspace typechecks. Replace it by running the command above.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: Record<string, { Row: Record<string, Json>; Insert: Record<string, Json>; Update: Record<string, Json> }>
    Views: Record<string, { Row: Record<string, Json> }>
    Functions: Record<string, { Args: Record<string, Json>; Returns: Json }>
    Enums: Record<string, string>
    CompositeTypes: Record<string, Record<string, Json>>
  }
}
