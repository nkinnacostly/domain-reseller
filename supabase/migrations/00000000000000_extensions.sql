-- Extensions used across the schema.
create extension if not exists "pgcrypto"   with schema extensions;
create extension if not exists "citext"     with schema extensions;
create extension if not exists "pg_cron";
create extension if not exists "pg_net"     with schema extensions;

comment on extension pg_cron is
  'Scheduled reconciliation: portfolio sync, float monitor, catalogue sync, FX update (PRD §13.5).';
