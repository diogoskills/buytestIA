-- Isolated billing namespace. No existing application data is modified.
create schema if not exists billing;
revoke all on schema billing from public, anon, authenticated;

create table billing.installation (
  id boolean primary key default true check(id),
  context jsonb not null,
  created_at timestamptz not null default now()
);

create table billing.products (
  id text primary key check (id ~ '^[a-z0-9-]{1,64}$'),
  name text not null,
  features jsonb not null default '[]',
  enabled boolean not null default true
);
create table billing.prices (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references billing.products,
  plan text not null check (plan in ('annual','lifetime')),
  version integer not null check (version > 0),
  currency text not null check (currency = 'BRL'),
  amount_cents integer not null check (amount_cents > 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique(product_id,plan,version)
);
create unique index prices_one_active on billing.prices(product_id,plan) where active;
-- Once referenced, a price can only be retired; version new prices instead.
create function billing.immutable_price() returns trigger language plpgsql as $$
begin
 if (new.product_id,new.plan,new.version,new.currency,new.amount_cents) is distinct from
    (old.product_id,old.plan,old.version,old.currency,old.amount_cents) then
   raise exception 'Create a new price version instead';
 end if;
 return new;
end $$;
create trigger price_version_immutable before update on billing.prices
for each row execute function billing.immutable_price();

create table billing.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  product_id text not null references billing.products,
  price_id uuid not null references billing.prices,
  snapshot jsonb not null,
  plan text not null check(plan in ('annual','lifetime')),
  amount_cents integer not null check(amount_cents>0),
  currency text not null check(currency='BRL'),
  request_key uuid not null,
  financial_status text not null default 'pending' check(financial_status in
    ('pending','approved','rejected','cancelled','expired','refunded','charged_back','review')),
  checkout_status text not null default 'creating' check(checkout_status in
    ('creating','ready','unknown','failed','closed')),
  preference_id text unique,
  checkout_url text,
  checkout_expires_at timestamptz not null,
  canonical_payment_id text,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_reconcile_at timestamptz default now(),
  unique(user_id,request_key)
);
create index orders_user_product on billing.orders(user_id,product_id,created_at desc);
create index orders_creating on billing.orders(created_at) where checkout_status='creating';
create index orders_expiring on billing.orders(checkout_expires_at) where financial_status='pending' and checkout_status='ready';
create index orders_due on billing.orders(next_reconcile_at) where next_reconcile_at is not null;
create table billing.checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references billing.orders,
  state text not null default 'creating',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table billing.payments (
  id text primary key,
  order_id uuid not null references billing.orders,
  status text not null,
  refunded_cents integer not null default 0,
  approved_at timestamptz,
  last_verified_at timestamptz not null default now(),
  duplicate boolean not null default false
);
create table billing.grants (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references billing.orders,
  payment_id text not null unique references billing.payments,
  user_id uuid not null references auth.users,
  product_id text not null references billing.products,
  plan text not null check(plan in ('annual','lifetime')),
  features jsonb not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now(),
  check ((plan='lifetime' and ends_at is null) or (plan='annual' and ends_at > starts_at))
);
create index grants_owner on billing.grants(user_id,product_id);
create table billing.activation_challenges (
  id uuid primary key,
  grant_id uuid not null references billing.grants,
  user_id uuid not null references auth.users,
  product_id text not null references billing.products,
  verifier text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index challenges_one_current on billing.activation_challenges(grant_id)
where consumed_at is null and invalidated_at is null;
create table billing.events (
  id uuid primary key default gen_random_uuid(),
  delivery_key text not null unique,
  resource_id text not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create table billing.jobs (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  kind text not null check(kind in ('payment','reconcile','email')),
  payload jsonb not null,
  state text not null default 'pending' check(state in ('pending','running','done','dead')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  error_code text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  provider_message_id text
);
create index jobs_ready on billing.jobs(state,available_at);
create table billing.auth_flows (
  id uuid primary key,
  browser_hash text not null,
  email_hash text not null,
  verifier_cipher text not null,
  product_id text not null references billing.products,
  plan text not null check(plan in ('annual','lifetime')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create table billing.sessions (
  id_hash text primary key,
  user_id uuid not null references auth.users,
  tokens_cipher text not null,
  token_expires_at timestamptz not null,
  expires_at timestamptz not null,
  intent jsonb,
  created_at timestamptz not null default now()
);
create table billing.rate_limits (
  key text primary key,
  hits integer not null,
  resets_at timestamptz not null
);

-- Every table is denied to browser roles. Queries go through the authenticated
-- API, with explicit owner predicates. Never expose billing as a Data API schema.
do $$ declare t text; begin
 foreach t in array array['installation','products','prices','orders','checkout_attempts','payments',
 'grants','activation_challenges','events','jobs','auth_flows','sessions','rate_limits'] loop
 execute format('alter table billing.%I enable row level security',t);
 execute format('revoke all on billing.%I from public, anon, authenticated',t);
 end loop;
end $$;
revoke all on all functions in schema billing from public, anon, authenticated;

insert into billing.products(id,name,features) values
 ('forma-premium','Forma Premium','["frete-gratis","acesso-antecipado"]');
-- No invented prices: activate versioned prices with npm run price after review.
