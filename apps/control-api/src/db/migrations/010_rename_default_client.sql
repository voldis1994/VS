-- Rename legacy "Default Client" to match booker naming convention.
UPDATE clients SET name = 'Kimly defolt', updated_at = NOW()
WHERE name = 'Default Client';
