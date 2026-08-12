import { NavLink, useLocation } from 'react-router-dom';
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Logo } from './Logo';
import { apiFetch } from '../hooks/useApi';
import {
  DeskAccount,
  DeskClient,
  DeskContext,
  DeskStatus,
} from './DeskContext';

const NAV = [
  { to: '/', label: 'MAIN DASHBOARD', end: true },
  { to: '/trading', label: 'TRADING' },
  { to: '/brokers', label: 'BROKERS' },
  { to: '/clients', label: 'CLIENTS' },
  { to: '/positions', label: 'POSITIONS' },
  { to: '/trades', label: 'TRADES' },
  { to: '/feeds', label: 'FEEDS' },
  { to: '/system', label: 'SYSTEM' },
  { to: '/settings', label: 'SETTINGS' },
];

function clientCount(status: DeskStatus | null): number {
  if (!status?.clients) return 0;
  if (typeof status.clients === 'number') return status.clients;
  return status.clients.active ?? 0;
}

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [clients, setClients] = useState<DeskClient[]>([]);
  const [accounts, setAccounts] = useState<DeskAccount[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, a] = await Promise.all([
        apiFetch<DeskStatus>('/api/system/status'),
        apiFetch<DeskClient[]>('/api/clients').catch(() => [] as DeskClient[]),
        apiFetch<DeskAccount[]>('/api/trading/accounts').catch(() => [] as DeskAccount[]),
      ]);
      setStatus(s);
      setClients(c);
      setAccounts(a);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!clients.length) {
      setSelectedClientId(null);
      return;
    }
    setSelectedClientId((prev) =>
      prev && clients.some((x) => x.id === prev) ? prev : clients[0].id,
    );
  }, [clients]);

  useEffect(() => {
    if (!accounts.length) {
      setSelectedAccountId(null);
      return;
    }
    setSelectedAccountId((prev) => {
      if (prev && accounts.some((x) => x.account_id === prev)) {
        if (!selectedClientId) return prev;
        const still = accounts.find((x) => x.account_id === prev);
        if (still && still.client_id === selectedClientId) return prev;
      }
      const forClient = selectedClientId
        ? accounts.filter((x) => x.client_id === selectedClientId)
        : accounts;
      return (forClient[0] || accounts[0]).account_id;
    });
  }, [accounts, selectedClientId]);

  const liveOk = (status?.database || '').toUpperCase() === 'HEALTHY';
  const markets = status?.capital_markets ?? 0;
  const openTrades = status?.open_positions ?? 0;
  const fills = status?.today_executions ?? 0;
  const brokersLive = status?.brokers_live ?? 0;

  const pageTitle =
    NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
      ?.label ?? 'CONTROL';

  const clientAccounts = useMemo(() => {
    if (!selectedClientId) return accounts;
    return accounts.filter((a) => a.client_id === selectedClientId);
  }, [accounts, selectedClientId]);

  const deskValue = useMemo(
    () => ({
      status,
      clients,
      accounts,
      selectedClientId,
      setSelectedClientId,
      selectedAccountId,
      setSelectedAccountId,
      refreshDesk: () => void load(),
    }),
    [status, clients, accounts, selectedClientId, selectedAccountId, load],
  );

  return (
    <DeskContext.Provider value={deskValue}>
      <div className="desk-shell">
        <header className="desk-header">
          <div className="desk-brand">
            <Logo size={36} />
            <div>
              <div className="desk-brand-title">MARKET READER</div>
              <div className="desk-brand-sub">{pageTitle}</div>
            </div>
          </div>

          <div className="desk-status-row">
            <span className={`status-pill ${liveOk ? '' : 'bad'}`}>
              SYSTEM {liveOk ? 'LIVE' : 'DEGRADED'}
            </span>
            <span className={`status-pill ${brokersLive > 0 ? '' : 'warn'}`}>
              CAPITAL {brokersLive > 0 ? 'LIVE' : 'IDLE'}
            </span>
            <span className={`status-pill ${openTrades > 0 ? '' : 'warn'}`}>
              POSITIONS {openTrades > 0 ? 'OPEN' : 'FLAT'}
            </span>
            <span className={`status-pill ${status?.live_enabled ? 'warn' : ''}`}>
              MODE {(status?.mode ?? 'PAPER').toUpperCase()}
            </span>
          </div>

          <div className="desk-stats">
            <div className="desk-stat">
              <div className="desk-stat-label">ACCOUNTS</div>
              <div className="desk-stat-value">{accounts.length}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">CLIENTS</div>
              <div className="desk-stat-value">{Math.max(clients.length, clientCount(status))}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">OPEN TRADES</div>
              <div className="desk-stat-value">{openTrades}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">TODAY FILLS</div>
              <div className="desk-stat-value up">{fills}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">SERVER</div>
              <div className="desk-stat-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {status?.server_time
                  ? new Date(status.server_time).toLocaleTimeString()
                  : '--:--:--'}
              </div>
            </div>
          </div>
        </header>

        <div className="desk-body">
          <aside className="desk-rail">
            <div className="rail-section">
              <div className="rail-title rail-title-row">
                <span>ACCOUNTS ({clients.length})</span>
                <NavLink to="/clients" className="rail-add">
                  + ADD
                </NavLink>
              </div>
              {clients.length === 0 && (
                <div className="rail-empty">No clients yet — open Clients or Brokers.</div>
              )}
              {clients.map((c) => {
                const accs = accounts.filter((a) => a.client_id === c.id);
                const marketsN = accs.reduce((s, a) => s + (a.capital_market_count || 0), 0);
                const active = selectedClientId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`account-chip ${active ? 'active' : ''}`}
                    onClick={() => setSelectedClientId(c.id)}
                  >
                    <div className="account-chip-name">
                      {c.name}
                      <span className={`dot ${c.enabled ? 'on' : 'off'}`} />
                    </div>
                    <div className="account-chip-meta account-chip-meta-row">
                      <span>{c.enabled ? 'ACTIVE' : 'OFF'} · {accs.length} acct</span>
                      <span>{marketsN.toLocaleString()} mkts</span>
                    </div>
                  </button>
                );
              })}
              <div className="rail-actions">
                <NavLink to="/brokers" className="btn btn-primary rail-btn">
                  OPEN BROKERS
                </NavLink>
                <NavLink to="/trading" className="btn rail-btn">
                  ACCOUNT MGMT
                </NavLink>
              </div>
            </div>

            <div className="rail-nav">
              <div className="rail-title" style={{ padding: '0 2px 8px' }}>
                CONTROL NAV
              </div>
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>

            <div className="rail-section">
              <div className="rail-title">MARKETS CACHED</div>
              <div className="metric-value" style={{ fontSize: 18 }}>
                {markets.toLocaleString()}
              </div>
              <div className="account-chip-meta" style={{ marginTop: 6 }}>
                Selected desk: {clientAccounts.length} linked account(s)
              </div>
            </div>
          </aside>

          <main className="desk-main">{children}</main>
        </div>

        <footer className="footer-strip desk-footer">
          <span>ALL CONTROL IN YOUR HANDS</span>
          <span>REAL-TIME DATA</span>
          <span>AI POWERED</span>
          <span>VISUAL ANALYSIS</span>
          <span>FULL AUTOMATION</span>
          <strong>MARKET READER TRADING SYSTEM</strong>
        </footer>
      </div>
    </DeskContext.Provider>
  );
}
