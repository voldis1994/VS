-- Seed a default client so Broker Connections can be saved without a prior Clients step.
-- Broker-agnostic name — never brand with a stock ticker like Kimly.
INSERT INTO clients (name)
SELECT 'Default Client'
WHERE NOT EXISTS (SELECT 1 FROM clients LIMIT 1);
