-- Product Listing Assistant: the complete database (PostgreSQL / Supabase).
--
-- With DATABASE_URL set, this is the app's database, and the backend runs this file on every
-- start (pla/db.py), so new tables and columns appear by themselves. You can also run it in the
-- Supabase SQL Editor. It is safe to run again: nothing is dropped and no existing row is changed.
--
-- Without DATABASE_URL the backend uses a local SQLite file with the same tables instead.
-- Column types match SQLite on purpose: lists and objects are JSON stored as text,
-- dates are ISO text, and yes/no flags are 0 or 1.

BEGIN;

-- One backend sets up the tables at a time, and a table that stays busy for 10 seconds makes this
-- give up instead of waiting forever (the backend then tries again).
SELECT pg_advisory_xact_lock(726401);
SET LOCAL lock_timeout = '10s';

-- ============================================================
-- Accounts, plans and billing
-- ============================================================

-- People who sign up. The admin is NOT a row here: the admin logs in with
-- ADMIN_EMAIL / ADMIN_PASSWORD from .env and has the id 'admin'.
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,                  -- scrypt$<salt>$<hash>
  status text NOT NULL DEFAULT 'active',        -- active | blocked
  searches_allowed integer NOT NULL DEFAULT 0,
  searches_used integer NOT NULL DEFAULT 0,
  plan_id text,
  created_at text NOT NULL,
  last_login_at text
);

-- The three plans on the Billing page. The admin can change them.
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  price text NOT NULL,
  searches integer NOT NULL,
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1,
  max_stores integer NOT NULL DEFAULT 1       -- how many Shopify stores the plan allows
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_stores integer NOT NULL DEFAULT 1;

-- A user asks for a plan; the admin approves or rejects it.
CREATE TABLE IF NOT EXISTS billing_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  plan_name text NOT NULL,
  price text NOT NULL,
  searches_requested integer NOT NULL,
  payment_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',       -- pending | approved | rejected
  searches_granted integer,
  admin_note text,
  created_at text NOT NULL,
  decided_at text
);

-- Every change to a user's searches (+2 on sign-up, -1 per product, admin changes).
CREATE TABLE IF NOT EXISTS search_log (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  product_id text,
  change integer NOT NULL,
  reason text NOT NULL,
  created_at text NOT NULL
);

-- ============================================================
-- Listings
-- ============================================================

-- One row per product listing. owner_id is the user who made it (NULL = admin).
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  stage text NOT NULL,
  input_name text,
  input_details text,
  input_image text,
  input_images text NOT NULL DEFAULT '[]',
  input_video text,
  input_urls text NOT NULL DEFAULT '[]',
  search_photos integer NOT NULL DEFAULT 1,
  search_videos integer NOT NULL DEFAULT 1,
  blocked_urls text NOT NULL DEFAULT '[]',
  vision text,
  name text,
  name_options text NOT NULL DEFAULT '[]',
  category text,
  description text,
  source_text text,
  claims text NOT NULL DEFAULT '[]',
  seller_name text,
  low_images integer NOT NULL DEFAULT 0,
  warnings text NOT NULL DEFAULT '[]',
  sku text UNIQUE,
  price text,
  cost text,
  shopify_status text NOT NULL DEFAULT 'ready',
  shopify_product_id text,
  shopify_admin_url text,
  shopify_handle text,
  shopify_error text,
  shopify_warnings text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  owner_id text
);

-- The research job of each product (the queue).
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  seq integer NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status text NOT NULL,
  step text,
  message text,
  log text NOT NULL DEFAULT '[]',
  skip_search integer NOT NULL DEFAULT 0,
  usage text NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  finished_at text
);

-- Web pages found for a product.
CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url text NOT NULL,
  title text,
  seller text,
  status text NOT NULL,
  reason text,
  text text,
  seq integer NOT NULL
);

-- Pictures found or uploaded for a product.
CREATE TABLE IF NOT EXISTS images (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_name text,
  source_url text,
  source_page text,
  width integer,
  height integer,
  bytes integer,
  phash text,
  passed integer NOT NULL DEFAULT 0,
  reason text,
  checks text NOT NULL DEFAULT '{}',
  selected integer NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  uploaded integer NOT NULL DEFAULT 0,
  added bigserial                               -- the order rows were added (SQLite's rowid)
);

-- Videos found or uploaded for a product.
CREATE TABLE IF NOT EXISTS videos (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL,
  provider text,
  url text,
  file_name text,
  source_page text,
  bytes integer,
  passed integer NOT NULL DEFAULT 0,
  reason text,
  selected integer NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  uploaded integer NOT NULL DEFAULT 0,
  added bigserial                               -- the order rows were added (SQLite's rowid)
);

-- ============================================================
-- App storage
-- ============================================================

-- Saved settings (Shopify details per account, auth secret, SerpAPI key choice, ...).
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- Running numbers (the 'sku' row gives each new product its SKU number).
CREATE TABLE IF NOT EXISTS counters (
  name text PRIMARY KEY,
  value integer NOT NULL
);

-- Saved results from the Creatives page, so the same search is not paid for twice.
CREATE TABLE IF NOT EXISTS creative_cache (
  cache_key text PRIMARY KEY,
  payload text NOT NULL,
  created_at text NOT NULL
);

-- ============================================================
-- Columns added by later versions (fills them in on an older database)
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS input_details text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS input_images text NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_photos integer NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_videos integer NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS usage text NOT NULL DEFAULT '{}';
ALTER TABLE images ADD COLUMN IF NOT EXISTS added bigserial;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS added bigserial;

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, seq);
CREATE INDEX IF NOT EXISTS jobs_product ON jobs(product_id);
CREATE INDEX IF NOT EXISTS sources_product ON sources(product_id);
CREATE INDEX IF NOT EXISTS images_product ON images(product_id);
CREATE INDEX IF NOT EXISTS videos_product ON videos(product_id);
CREATE INDEX IF NOT EXISTS products_owner ON products(owner_id);
CREATE INDEX IF NOT EXISTS billing_requests_user ON billing_requests(user_id, status);
CREATE INDEX IF NOT EXISTS search_log_user ON search_log(user_id, created_at);

-- The Shopify stores a signed-in user connected (the admin uses the plain settings keys).
CREATE TABLE IF NOT EXISTS shopify_stores (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  domain text NOT NULL,
  method text NOT NULL DEFAULT 'client',
  client_id text NOT NULL DEFAULT '',
  client_secret text NOT NULL DEFAULT '',
  admin_token text NOT NULL DEFAULT '',
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shopify_stores_owner_domain ON shopify_stores (owner_id, domain);

-- ============================================================
-- Default plans (only when there are no plans yet, the same as the app does)
-- ============================================================

INSERT INTO plans (id, name, price, searches, description, position, active, max_stores)
SELECT p.id, p.name, p.price, p.searches, p.description, p.position, 1, p.max_stores
FROM (VALUES
  ('starter',  'Starter',  'Rs 1,000 / month',  25, 'For trying the app with a few products.',      0,  1),
  ('pro',      'Pro',      'Rs 2,500 / month',  75, 'For a store that lists products every week.',  1,  3),
  ('business', 'Business', 'Rs 6,000 / month', 200, 'For teams that list many products every day.', 2, 10)
) AS p(id, name, price, searches, description, position, max_stores)
WHERE NOT EXISTS (SELECT 1 FROM plans);

-- ============================================================
-- Access: only the backend (DATABASE_URL) reads and writes these tables.
-- Supabase's public keys (anon, authenticated) get nothing, because users holds
-- password hashes and settings holds Shopify tokens.
-- ============================================================

ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE images           ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_stores   ENABLE ROW LEVEL SECURITY;
ALTER TABLE counters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_cache   ENABLE ROW LEVEL SECURITY;

-- The anon and authenticated roles exist only on Supabase; plain Postgres skips this step.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE
      users, plans, billing_requests, search_log,
      products, jobs, sources, images, videos,
      settings, counters, creative_cache, shopify_stores
    FROM anon, authenticated;
  END IF;
END $$;

COMMIT;
