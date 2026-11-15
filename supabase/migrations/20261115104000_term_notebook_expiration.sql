alter table public.citation_drafts
  add column term_id uuid,
  add foreign key (council_id, term_id) references public.council_terms(council_id, id);

create index citation_drafts_term on public.citation_drafts(term_id) where term_id is not null;

create function public.bind_citation_draft_to_term()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  latest public.council_terms%rowtype;
begin
  perform 1 from public.councils where id = new.council_id for update;
  select * into latest from public.council_terms
  where council_id = new.council_id order by starts_at desc limit 1;
  if not found then return new; end if;
  if latest.finalized_at is not null or clock_timestamp() >= latest.ends_at then
    raise exception 'The Term has ended. Drafts reopen when the next Term starts.';
  end if;
  new.term_id := latest.id;
  return new;
end;
$$;
revoke all on function public.bind_citation_draft_to_term() from public, anon, authenticated;
create trigger citation_drafts_bind_term before insert on public.citation_drafts
for each row execute function public.bind_citation_draft_to_term();

-- Preserve pre-Term drafts and adopt them when the Council opens its first Term.
create function public.adopt_preterm_citation_drafts()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.citation_drafts set term_id = new.id
    where council_id = new.council_id and term_id is null;
  return new;
end;
$$;
revoke all on function public.adopt_preterm_citation_drafts() from public, anon, authenticated;
create trigger council_terms_adopt_drafts after insert on public.council_terms
for each row execute function public.adopt_preterm_citation_drafts();

create policy citation_draft_term_unexpired on public.citation_drafts as restrictive
for all to authenticated
using (term_id is null or exists (
  select 1 from public.council_terms t
  where t.id = citation_drafts.term_id and t.ends_at > statement_timestamp()
))
with check (term_id is null or exists (
  select 1 from public.council_terms t
  where t.id = citation_drafts.term_id and t.ends_at > statement_timestamp()
));

create function public.purge_expired_citation_drafts()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  deleted bigint;
begin
  delete from public.citation_drafts draft using public.council_terms term
  where draft.term_id = term.id and term.ends_at <= statement_timestamp();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
revoke all on function public.purge_expired_citation_drafts() from public, anon, authenticated;
