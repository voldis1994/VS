import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { apiFetch, useApi } from '../../hooks/useApi';

type BrokerRow = Record<string, unknown>;
type Client = { id: number; name: string };

export function BrokersView() {
  const { data, error, loading, refresh } = useApi<BrokerRow[]>('/api/brokers');
  const { data: clients, refresh: refreshClients } = useApi<Client[]>('/api/clients');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const testBroker = async (id: number) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ success?: boolean; message?: string; error?: string }>(
        `/api/brokers/${id}/test`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMsg(res.message || res.error || (res.success ? 'OK' : 'Failed'));
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // BROKERS"
        title="Brokers"
        stats={[
          { label: 'Brokers', value: data?.length ?? 0 },
          { label: 'Clients', value: clients?.length ?? 0 },
        ]}
      />
      {loading && <div className="cmd-banner cmd-banner--busy">Loading…</div>}
      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      {msg && <div className="cmd-banner cmd-banner--ok">{msg}</div>}

      <section className="cmd-panel">
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Broker</th>
                <th>Env</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data || []).length === 0 && (
                <tr>
                  <td colSpan={5} className="mono">
                    No brokers — add via API or legacy flow
                  </td>
                </tr>
              )}
              {(data || []).map((b) => (
                <tr key={String(b.id)}>
                  <td>{String(b.client_name || '—')}</td>
                  <td>{String(b.broker_name || b.name || '—')}</td>
                  <td className="mono">{String(b.environment || '—')}</td>
                  <td>
                    <span className="cmd-badge cmd-badge--ok">{String(b.status || '—')}</span>
                  </td>
                  <td>
                    <button
                      className="cmd-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void testBroker(Number(b.id))}
                    >
                      Test
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          className="cmd-btn"
          type="button"
          style={{ marginTop: '0.75rem' }}
          onClick={() => {
            refresh();
            refreshClients();
          }}
        >
          Refresh
        </button>
      </section>
    </div>
  );
}
