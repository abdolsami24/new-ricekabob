-- ============================================================================
-- Madinah Market — Fresh KDS schema: send-result columns on orders.
-- Run ONCE in your Supabase project: SQL Editor -> New query -> paste
-- this whole file -> Run. It is IDEMPOTENT — safe to run again.
--
-- What it adds:
--   * orders.freshkds_status  — 'sent' | 'failed' (null = never sent,
--     e.g. FRESHKDS_TOKEN not set yet, or the order predates the
--     integration).
--   * orders.freshkds_error   — the last Fresh KDS error message when
--     a send failed (shown in Admin -> Orders -> order detail).
--   * orders.freshkds_sent_at — when the order reached the screens.
-- The website code fails soft until this file is run: orders keep
-- working and the Fresh KDS result simply isn't recorded.
-- ============================================================================

alter table public.orders
  add column if not exists freshkds_status text,
  add column if not exists freshkds_error text,
  add column if not exists freshkds_sent_at timestamptz;

-- Re-assert the service_role grants for the whole public schema so the
-- new columns are covered even on a fresh project (this project does
-- not auto-grant table privileges to service_role).
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
