create function public.advance_council_term(p_council_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  previous_term public.council_terms%rowtype;
  next_term_id uuid;
  next_start timestamptz;
  pending record;
begin
  perform 1 from public.councils where id = p_council_id for update;
  if not found then raise exception 'Council not found'; end if;

  select * into previous_term
  from public.council_terms
  where council_id = p_council_id
  order by starts_at desc
  limit 1 for update;
  if not found then return null; end if;

  for pending in
    select id from public.council_citations
    where term_id = previous_term.id and resolved_at is null
      and voting_closes_at <= clock_timestamp()
    order by voting_closes_at, id
  loop
    perform public.settle_council_citation(pending.id);
  end loop;

  if not public.finalize_council_term(previous_term.id) then
    return previous_term.id;
  end if;

  next_start := clock_timestamp();
  insert into public.council_terms (council_id, starts_at, ends_at)
  values (p_council_id, next_start, next_start + (previous_term.ends_at - previous_term.starts_at))
  returning id into next_term_id;

  insert into public.council_term_points (council_id, term_id, user_id, points)
  select p_council_id, next_term_id, m.user_id, coalesce(
    (select case when score.points = 0 then 0 else 100 end
     from public.council_term_points score
     join public.council_terms score_term on score_term.id = score.term_id
     where score.council_id = p_council_id and score.user_id = m.user_id
     order by score_term.starts_at desc
     limit 1
    ), 100)
  from public.council_members m
  where m.council_id = p_council_id;

  return next_term_id;
end;
$$;

revoke all on function public.advance_council_term(uuid) from public, anon, authenticated;
