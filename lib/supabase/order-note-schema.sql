-- ============================================================================
-- Madinah Market — Order-note schema: the customer's order-level
-- checkout note ("Pickup note (optional)" on the storefront) gets a
-- home on the orders row.
-- Run ONCE in your Supabase project: SQL Editor -> New query -> paste
-- this whole file -> Run. It is IDEMPOTENT — safe to run again.
--
-- What it adds:
--   * orders.note — the order-level note typed at checkout (up to 200
--     chars, enforced in /api/checkout). Shown on the printed ticket,
--     the kitchen board, the admin order detail and the owner email.
--     (Per-dish "special instructions" are separate — they already
--     live inside items_json and print under each dish.)
-- The website code fails soft until this file is run: checkout saves
-- orders without the note, and the ticket / board / admin / email
-- simply show no note line.
-- ============================================================================

alter table public.orders
  add column if not exists note text;

-- Re-assert the service_role grants for the whole public schema so the
-- new column is covered even on a fresh project (this project does
-- not auto-grant table privileges to service_role).
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
