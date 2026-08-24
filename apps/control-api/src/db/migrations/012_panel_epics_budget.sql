-- Client allowlist 1–3 markets + budget % of account equity for sizing
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS panel_epics TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS panel_budget_pct NUMERIC(6,2) NOT NULL DEFAULT 25.00;

-- Backfill from legacy single panel_epic
UPDATE clients
SET panel_epics = ARRAY[panel_epic]
WHERE panel_epic IS NOT NULL
  AND length(trim(panel_epic)) > 0
  AND (panel_epics IS NULL OR cardinality(panel_epics) = 0);
