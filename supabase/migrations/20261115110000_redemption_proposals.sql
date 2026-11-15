create table public.council_redemptions (
  id uuid primary key default gen_random_uuid(),
  council_id uuid not null,
  originating_term_id uuid not null,
  member_id uuid not null,
  challenge text not null check (char_length(btrim(challenge)) between 1 and 2000),
  proposed_completion_at timestamptz not null,
  created_at timestamptz not null,
  approval_closes_at timestamptz not null,
  status text not null default 'approval_open'
    check (status in ('approval_open','approved','verification_open','restored','rejected','expired')),
  foreign key (council_id, originating_term_id) references public.council_terms(council_id,id),
  check (proposed_completion_at > approval_closes_at)
);
create unique index council_redemptions_one_open
  on public.council_redemptions(council_id,member_id)
  where status in ('approval_open','approved','verification_open');
alter table public.council_redemptions enable row level security;
revoke all on public.council_redemptions from public, anon, authenticated;
grant select on public.council_redemptions to authenticated;
create policy council_redemptions_member_read on public.council_redemptions
  for select to authenticated using (exists (
    select 1 from public.council_members m
    where m.council_id = council_redemptions.council_id and m.user_id = (select auth.uid())
  ));

create function public.propose_council_redemption(
  p_council_id uuid, p_challenge text, p_completion_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  active_term uuid;
  proposed_at timestamptz;
  request_id uuid;
begin
  if caller is null or not exists (
    select 1 from public.council_members where council_id = p_council_id and user_id = caller
  ) then raise exception 'Council membership is required'; end if;
  perform 1 from public.councils where id = p_council_id for update;
  proposed_at := clock_timestamp();
  select id into active_term from public.council_terms
  where council_id = p_council_id and finalized_at is null
    and starts_at <= proposed_at and ends_at > proposed_at;

  if not exists (
    select 1 from public.council_term_points score
    join public.council_members member on member.council_id = score.council_id
      and member.user_id = score.user_id
    where score.term_id = active_term and score.user_id = caller and score.points = 0
  ) then raise exception 'A revoked Man Card in an active Term is required'; end if;
  if (
    select count(distinct user_id) from public.council_members
    where council_id = p_council_id and user_id <> caller and joined_at <= proposed_at
  ) < 2 then raise exception 'At least two eligible Council voters are required'; end if;

  insert into public.council_redemptions
    (council_id, originating_term_id, member_id, challenge, proposed_completion_at, created_at, approval_closes_at)
  values (p_council_id, active_term, caller, btrim(p_challenge), p_completion_at,
    proposed_at, proposed_at + interval '24 hours')
  returning id into request_id;
  return request_id;
end;
$$;
revoke all on function public.propose_council_redemption(uuid,text,timestamptz)
  from public, anon, authenticated;
