create table public.council_citations (
  id uuid primary key default gen_random_uuid(),
  council_id uuid not null references public.councils(id),
  accuser_id uuid not null default auth.uid(),
  accused_id uuid not null,
  incident text not null check (char_length(btrim(incident)) between 1 and 4000),
  proposed_points smallint not null check (proposed_points in (5,10,15,20,25)),
  created_at timestamptz not null default statement_timestamp(),
  voting_closes_at timestamptz not null default statement_timestamp() + interval '24 hours',
  check (accuser_id <> accused_id)
);
create index council_citations_council_recent on public.council_citations(council_id, created_at desc);
alter table public.council_citations enable row level security;
revoke all on public.council_citations from public, anon, authenticated;
grant select on public.council_citations to authenticated;
create policy council_citations_member_read on public.council_citations
for select to authenticated using (
  exists (
    select 1 from public.council_members member
    where member.council_id = council_citations.council_id
      and member.user_id = (select auth.uid())
  )
);
-- Filing remains server-only until Term and voting checks are in place.
