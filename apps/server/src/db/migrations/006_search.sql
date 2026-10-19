-- Search support (Task 9): accent-insensitive fulltext and tolerant date parsing for filters.
create extension if not exists unaccent;

-- `simple` (no stemming, lower-casing) plus unaccent, so "cafe" matches "Café" and "Кишинев" matches "Кишинёв".
-- Used by the one tsvector/tsquery helper pair in src/domain/documents.ts (SEARCH_CONFIG).
create text search configuration smaltic_search (copy = simple);
alter text search configuration smaltic_search
  alter mapping for asciiword, asciihword, hword_asciipart, word, hword, hword_part, numword, numhword, hword_numpart
  with unaccent, simple;

-- Stored Date ("YYYY-MM-DD", UTC midnight) or Timestamp ("YYYY-MM-DDTHH:MM:SS+0000") value -> timestamptz.
-- Returns null for anything else (e.g. content stored before a field was retyped) instead of raising.
create or replace function smaltic_ts(s text) returns timestamptz
language plpgsql immutable strict parallel safe as $$
begin
  if s ~ '^\d{4}-\d{2}-\d{2}$' then
    return (s || 'T00:00:00+00:00')::timestamptz;
  end if;
  if s ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then
    return s::timestamptz;
  end if;
  return null;
exception when others then
  return null;
end $$;
