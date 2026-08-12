-- Seed a default client so Broker Connections can be saved without a prior Clients step.
INSERT INTO clients (name)
SELECT 'Default Client'
WHERE NOT EXISTS (SELECT 1 FROM clients LIMIT 1);
