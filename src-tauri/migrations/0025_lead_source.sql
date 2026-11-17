-- How a lead arrived, which is what decides whether the Leads page shows the person or the
-- list they came in with: 'import' is one row of a CSV/XLSX, 'manual' is someone typed in,
-- and 'single' is a lead the composer made for a hand-written email.
--
-- The column already existed for 'single' and was left empty for everything else, so the
-- rows that predate this are worked out here. A lead sharing its list with another lead
-- arrived with other people, which is what an import looks like — and the two names that
-- are not really lists are excluded: a bare insert falls back to 'Unassigned', and the
-- composer files its leads under 'Single emails'. Everything else came in one at a time.
UPDATE leads SET source = 'import'
  WHERE source IS NULL
    AND list_name NOT IN ('Unassigned', 'Single emails')
    AND list_name IN (
      SELECT list_name FROM leads GROUP BY list_name HAVING count(*) > 1
    );

UPDATE leads SET source = 'manual' WHERE source IS NULL;
