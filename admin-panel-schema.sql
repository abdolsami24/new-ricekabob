-- Madinah Market — Operations admin panel add-on (run ONCE in Supabase
-- SQL Editor, after schema.sql / accounts-schema.sql / admin-schema.sql /
-- loyalty-schema.sql).
-- Adds: (1) a kitchen-station column on menu_items for the Catalog editor,
-- (2) the admin_audit table backing the panel's Audit log section.
-- Safe to re-run: every statement is idempotent.

-- (1) Kitchen station per dish ("main" unless the kitchen says otherwise).
-- The panel code defaults to "main" whenever this column or its value is
-- missing, so the site works the same before and after this runs.
alter table public.menu_items
  add column if not exists station text not null default 'main';

-- (2) Audit log: one row per admin mutation (settings, hours, catalog
-- edits, availability, promotions, order status changes). Written by the
-- server on a best-effort basis — a missing table never blocks a change;
-- the panel's Audit log section simply asks for this file to be run.
create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  actor text,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx
  on public.admin_audit (created_at desc);

-- RLS on, no public policies: only the server (service-role key) reads or
-- writes this table, after it has verified the caller's staff token.
alter table public.admin_audit enable row level security;

-- Newer Supabase projects do not auto-grant table privileges to the
-- service_role role (learned 2026-11-17) — grant explicitly.
grant all on public.admin_audit to service_role;
grant all on all sequences in schema public to service_role;
