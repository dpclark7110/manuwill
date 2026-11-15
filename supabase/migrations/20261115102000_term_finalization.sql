create table public.council_term_standings (
  term_id uuid not null references public.council_terms(id),
  user_id uuid not null,
  points integer not null check (points >= 0),
  place integer not null check (place >= 1),
  champion boolean not null,
  survivor boolean not null,
  primary key (term_id, user_id)
);
alter table public.council_term_standings enable row level security;
revoke all on public.council_term_standings from public, anon, authenticated;
grant select on public.council_term_standings to authenticated;
create policy council_term_standings_member_read on public.council_term_standings
for select to authenticated using (
  exists (select 1 from public.council_terms t where t.id = council_term_standings.term_id)
);

create function public.finalize_council_term(p_term_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  term public.council_terms%rowtype;
  council uuid;
  pending record;
begin
  select council_id into council from public.council_terms where id = p_term_id;
  if not found then raise exception 'Term not found'; end if;
  perform 1 from public.councils where id = council for update;
  select * into strict term from public.council_terms where id = p_term_id for update;
  if term.finalized_at is not null then return true; end if;
  if clock_timestamp() < term.ends_at then return false; end if;

  for pending in
    select id from public.council_citations
    where term_id = term.id and resolved_at is null
    order by voting_closes_at, id
  loop
    if public.settle_council_citation(pending.id) is null then return false; end if;
  end loop;

  with scores as (
    select m.user_id, coalesce(s.points, 100) as points,
      greatest(m.joined_at, term.starts_at) <= term.starts_at + (term.ends_at - term.starts_at) / 2
        as champion_eligible
    from public.council_members m
    left join public.council_term_points s on s.term_id = term.id and s.user_id = m.user_id
    where m.council_id = term.council_id and m.joined_at < term.ends_at
  ), ranked as (
    select scores.*,
      rank() over (order by points desc) as place,
      max(points) filter (where champion_eligible and points > 0) over () as champion_points
    from scores
  )
  insert into public.council_term_standings (term_id, user_id, points, place, champion, survivor)
  select term.id, user_id, points, place,
    champion_eligible and coalesce(points = champion_points, false), points > 0
  from ranked;

  update public.council_terms set finalized_at = clock_timestamp() where id = term.id;
  return true;
end;
$$;
revoke all on function public.finalize_council_term(uuid) from public, anon, authenticated;
