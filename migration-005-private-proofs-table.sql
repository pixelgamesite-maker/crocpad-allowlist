-- Run in the Supabase SQL Editor. Creates a table to hold Merkle proofs
-- privately — this replaces publishing a public proofs.json file, which
-- would let anyone see the full approved wallet list and count.

create table if not exists public.crocpad_proofs (
  wallet_address text primary key,
  proof jsonb not null,
  created_at timestamptz not null default now()
);

-- RLS enabled with NO policies at all — meaning nobody using the anon
-- key can read, insert, update, or delete rows here, period. Only the
-- service_role key (used server-side only, e.g. by generate-allowlist.mjs
-- and the lookup API below) can touch this table, since service_role
-- bypasses RLS by design.
alter table public.crocpad_proofs enable row level security;

-- Deliberately no CREATE POLICY statements — that's what keeps this
-- table fully private. Do not add a public select policy here.
