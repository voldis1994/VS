-- Undo #315 Kimly branding. Client names stay broker-agnostic;
-- market labels come from Capital.com (or other broker) catalog pull.
UPDATE clients SET name = 'Default Client', updated_at = NOW()
WHERE name IN ('Kimly defolt', 'Kimly default', 'Kimly');
