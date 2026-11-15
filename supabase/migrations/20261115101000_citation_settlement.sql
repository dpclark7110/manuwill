alter table public.council_citations
  add column verdict text check (verdict in ('guilty', 'not_guilty', 'bogus_claim', 'dismissed')),
  add column resolved_at timestamptz,
  add column resolution_reason text,
  add check ((verdict is null) = (resolved_at is null));

create table public.council_term_points (
  council_id uuid not null,
  term_id uuid not null,
  user_id uuid not null,
  points integer not null default 100 check (points >= 0),
  primary key (term_id, user_id),
  foreign key (council_id, term_id) references public.council_terms(council_id, id)
);
alter table public.council_term_points enable row level security;
revoke all on public.council_term_points from public, anon, authenticated;
grant select on public.council_term_points to authenticated;
create policy council_term_points_member_read on public.council_term_points for select to authenticated
using (exists (
  select 1 from public.council_members m where m.council_id = council_term_points.council_id
    and m.user_id = (select auth.uid())
));

create function public.settle_council_citation(p_citation_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  citation public.council_citations%rowtype;
  council uuid;
  outcome text;
  reason text;
  total_votes integer;
  guilty_votes integer;
  not_guilty_votes integer;
  bogus_votes integer;
begin
  select council_id into council from public.council_citations where id = p_citation_id;
  if council is null then raise exception 'Citation not found'; end if;
  -- Share the Council lock with filing and future membership and Term transitions.
  perform 1 from public.councils where id = council for update;
  select * into strict citation from public.council_citations where id = p_citation_id for update;
  if citation.resolved_at is not null then return citation.verdict; end if;
  if clock_timestamp() < citation.voting_closes_at then return null; end if;

  select count(*), count(*) filter (where v.verdict = 'guilty'),
    count(*) filter (where v.verdict = 'not_guilty'),
    count(*) filter (where v.verdict = 'bogus_claim')
  into total_votes, guilty_votes, not_guilty_votes, bogus_votes
  from public.citation_votes v where v.citation_id = citation.id;

  if total_votes < 2 then
    outcome := 'dismissed';
    reason := 'Fewer than two votes cast';
  elsif guilty_votes * 2 > total_votes then outcome := 'guilty';
  elsif not_guilty_votes * 2 > total_votes then outcome := 'not_guilty';
  elsif bogus_votes * 2 > total_votes then outcome := 'bogus_claim';
  else
    outcome := 'dismissed';
    reason := 'No verdict received a majority';
  end if;

  if outcome = 'guilty' then
    insert into public.council_term_points as score (council_id, term_id, user_id, points)
    values
      (council, citation.term_id, citation.accused_id, 100 - citation.proposed_points),
      (council, citation.term_id, citation.accuser_id, 105)
    on conflict (term_id, user_id) do update set points = case
      when score.points = 0 then 0
      when score.user_id = citation.accused_id then greatest(0, score.points - citation.proposed_points)
      else score.points + 5
    end;
  elsif outcome = 'bogus_claim' then
    insert into public.council_term_points as score (council_id, term_id, user_id, points)
    values (council, citation.term_id, citation.accuser_id, 95)
    on conflict (term_id, user_id) do update set points = greatest(0, score.points - 5);
  end if;

  update public.council_citations
  set verdict = outcome, resolved_at = clock_timestamp(), resolution_reason = reason
  where id = citation.id;
  return outcome;
end;
$$;
revoke all on function public.settle_council_citation(uuid) from public, anon, authenticated;
