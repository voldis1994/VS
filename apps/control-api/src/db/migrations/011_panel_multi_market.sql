-- Multi-market clients accept EntryReady for any epic in their Capital catalog
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS panel_multi_market BOOLEAN NOT NULL DEFAULT false;
