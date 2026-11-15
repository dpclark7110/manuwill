create table public.council_terms (
  id uuid primary key default gen_random_uuid(),
  council_id uuid not null references public.councils(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  finalized_at timestamptz,
  unique (council_id, id),
  check (ends_at > starts_at)
);
create unique index council_terms_one_open on public.council_terms(council_id)
  where finalized_at is null;
alter table public.council_terms enable row level security;
revoke all on public.council_terms from public, anon, authenticated;
grant select on public.council_terms to authenticated;
create policy council_terms_member_read on public.council_terms for select to authenticated
using (exists (
  select 1 from public.council_members m where m.council_id = council_terms.council_id
    and m.user_id = (select auth.uid())
));

alter table public.council_citations add column term_id uuid not null,
  add foreign key (council_id, term_id) references public.council_terms(council_id, id);

create table public.citation_votes (
  citation_id uuid not null references public.council_citations(id),
  voter_id uuid not null,
  verdict text not null check (verdict in ('guilty', 'not_guilty', 'bogus_claim')),
  primary key (citation_id, voter_id)
);
alter table public.citation_votes enable row level security;
revoke all on public.citation_votes from public, anon, authenticated;

create function public.file_council_citation(
  p_council_id uuid, p_accused_id uuid, p_incident text, p_proposed_points smallint
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  term uuid;
  filed_at timestamptz;
  citation uuid;
begin
  if caller is null then raise exception 'Sign in to file a citation'; end if;
  perform 1 from public.councils where id = p_council_id for update;
  select id into term from public.council_terms
    where council_id = p_council_id and finalized_at is null for update;
  filed_at := clock_timestamp();
  if term is null or not exists (
    select 1 from public.council_terms
    where id = term and starts_at <= filed_at and ends_at > filed_at
  ) then raise exception 'The Council has no active Term'; end if;
  if p_accused_id is null or p_accused_id = caller or (
    select count(distinct m.user_id) from public.council_members m
    where m.council_id = p_council_id and m.user_id in (caller, p_accused_id)
  ) <> 2 then raise exception 'Choose another member of this Council'; end if;
  if (
    select count(distinct m.user_id) from public.council_members m
    where m.council_id = p_council_id and m.user_id not in (caller, p_accused_id)
      and m.joined_at <= filed_at
  ) < 2 then raise exception 'At least two eligible voters are required'; end if;

  insert into public.council_citations
    (council_id, term_id, accuser_id, accused_id, incident, proposed_points, created_at, voting_closes_at)
    values (p_council_id, term, caller, p_accused_id, btrim(p_incident),
      p_proposed_points, filed_at, filed_at + interval '24 hours')
    returning id into citation;
  return citation;
end;
$$;

create function public.vote_on_citation(p_citation_id uuid, p_verdict text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  citation public.council_citations%rowtype;
begin
  if caller is null then raise exception 'Sign in to vote'; end if;
  select * into citation from public.council_citations where id = p_citation_id for update;
  if not found or caller in (citation.accuser_id, citation.accused_id) or not exists (
    select 1 from public.council_members m where m.council_id = citation.council_id
      and m.user_id = caller and m.joined_at <= citation.created_at
  ) then raise exception 'You are not eligible to vote on this citation'; end if;
  if clock_timestamp() >= citation.voting_closes_at then raise exception 'Voting has closed'; end if;
  insert into public.citation_votes(citation_id, voter_id, verdict)
    values (citation.id, caller, p_verdict)
    on conflict (citation_id, voter_id) do update set verdict = excluded.verdict;
end;
$$;

-- Enable these endpoints only alongside dismissal, settlement and Term lifecycle.
revoke all on function public.file_council_citation(uuid, uuid, text, smallint)
  from public, anon, authenticated;
revoke all on function public.vote_on_citation(uuid, text) from public, anon, authenticated;
