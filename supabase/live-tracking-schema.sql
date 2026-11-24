-- Live delivery tracking (2026-11-23) — run once in the Supabase
-- SQL editor, like the earlier schema files.
--
-- delivery_tracking_url: DoorDash Drive's live-map page for the
-- delivery, saved at dispatch and refreshed by the webhook /
-- staff refresh. Shown to the customer on /track and in Admin.
--
-- driver_lat / driver_lng / driver_loc_at: House Delivery — the
-- driver's phone posts its GPS from the driver page while a
-- delivery runs; /track and Admin draw the live map from the
-- latest fix. Cleared by nothing — a delivered order simply stops
-- updating, and the pages stop showing the map once delivered.

alter table orders add column if not exists delivery_tracking_url text;
alter table orders add column if not exists driver_lat double precision;
alter table orders add column if not exists driver_lng double precision;
alter table orders add column if not exists driver_loc_at timestamptz;
