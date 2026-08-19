import { apiFetch } from './useApi';

export type PullCapitalResult = {
  accountId: number;
  synced_accounts: number;
  markets: number;
};

/** Sync Capital accounts, then pull the full market tree (1–3 min). */
export async function pullCapital(accountId?: number | null): Promise<PullCapitalResult> {
  const sync = await apiFetch<{ synced_accounts: number }>('/api/trading/accounts/sync', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  let id = accountId ?? null;
  if (!id) {
    const accs = await apiFetch<Array<{ account_id: number }>>('/api/trading/accounts');
    id = accs[0]?.account_id ?? null;
  }
  if (!id) {
    throw new Error('Nav Capital konta. BROKERS → SAVE API key + TEST, tad PULL CAPITAL.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await apiFetch<{ count: number }>(
      `/api/trading/accounts/${id}/pull-capital-markets`,
      { method: 'POST', body: JSON.stringify({}), signal: controller.signal }
    );
    return { accountId: id, synced_accounts: sync.synced_accounts, markets: res.count };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('PULL CAPITAL timeout (3 min). Spied vēlreiz — Capital 429 var aizkavēt.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
