create function public.file_citation_from_draft(
  p_council_id uuid,
  p_draft_id uuid,
  p_accused_id uuid,
  p_incident text,
  p_proposed_points smallint
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  filed_citation uuid;
begin
  if caller is null then raise exception 'Sign in to file a citation'; end if;
  perform 1 from public.councils where id = p_council_id for update;
  perform 1 from public.citation_drafts draft
  join public.council_terms term on term.id = draft.term_id
  where draft.id = p_draft_id and draft.council_id = p_council_id
    and draft.owner_id = caller and term.finalized_at is null
    and term.starts_at <= clock_timestamp() and term.ends_at > clock_timestamp()
  for update of draft;
  if not found then raise exception 'This draft is unavailable in the current Term'; end if;

  filed_citation := public.file_council_citation(
    p_council_id, p_accused_id, p_incident, p_proposed_points
  );
  delete from public.citation_drafts where id = p_draft_id;
  return filed_citation;
end;
$$;
revoke all on function public.file_citation_from_draft(uuid, uuid, uuid, text, smallint)
  from public, anon, authenticated;
