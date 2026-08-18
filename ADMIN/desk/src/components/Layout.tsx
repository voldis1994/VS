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
import type { ServerMonitor } from '../types/serverMonitor';
import { infraHealthy, isOnline } from '../types/serverMonitor';

const NAV = [
  { to: '/', label: 'COMMAND', end: true },
  { to: '/robot', label: 'ROBOT BOARD' },
  { to: '/market', label: 'REGIMES' },
  { to: '/orbit', label: 'ORBIT GRID' },
  { to: '/trading', label: 'TRADING' },
  { to: '/brokers', label: 'BROKERS' },
  { to: '/clients', label: 'CLIENTS' },
  { to: '/network', label: 'NETWORK' },
  { to: '/positions', label: 'POSITIONS' },
  { to: '/trades', label: 'TRADES' },
  { to: '/feeds', label: 'FEEDS' },
  { to: '/system', label: 'SERVER' },
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
  const [monitor, setMonitor] = useState<ServerMonitor | null>(null);
  const [clients, setClients] = useState<DeskClient[]>([]);
  const [accounts, setAccounts] = useState<DeskAccount[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, a, mon] = await Promise.all([
        apiFetch<DeskStatus>('/api/system/status').catch(() => null),
        apiFetch<DeskClient[]>('/api/clients').catch(() => [] as DeskClient[]),
        apiFetch<DeskAccount[]>('/api/trading/accounts').catch(() => [] as DeskAccount[]),
        apiFetch<ServerMonitor>('/api/v1/server/monitor'),
      ]);
      setStatus(s);
      setClients(c);
      setAccounts(a);
      setMonitor(mon);
      setServerOnline(isOnline(mon.api.status));
    } catch {
      setServerOnline(false);
      setStatus(null);
      setMonitor(null);
      setClients([]);
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
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

  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* browser blocked fullscreen */
    }
  };

  const healthy = infraHealthy(monitor);
  const openTrades = serverOnline ? (status?.open_positions ?? 0) : 0;
  const fills = serverOnline ? (status?.today_executions ?? 0) : 0;
  const markets = serverOnline ? (status?.capital_markets ?? 0) : 0;

  const pageTitle =
    NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))
      ?.label ?? 'CONTROL';

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
      monitor,
    }),
    [status, clients, accounts, selectedClientId, selectedAccountId, load, monitor],
  );

  return (
    <DeskContext.Provider value={deskValue}>
      <div className={`desk-shell${railCollapsed ? ' rail-collapsed' : ''}${isFs ? ' is-fs' : ''}`}>
        <header className="desk-header">
          <div className="header-chrome">
            <button
              type="button"
              className="btn"
              title="Collapse / expand left rail"
              onClick={() => setRailCollapsed((v) => !v)}
            >
              {railCollapsed ? '☰' : '◀'}
            </button>
          </div>
          <div className="desk-brand">
            <Logo size={52} wordmark />
            <div className="desk-brand-sub">{pageTitle}</div>
          </div>

          <div className="desk-status-row">
            <span className={`status-pill ${serverOnline === false ? 'bad' : healthy ? '' : 'warn'}`}>
              {serverOnline === false
                ? 'SERVER OFFLINE'
                : `VS ADMIN · ${healthy ? 'INFRA OK' : 'DEGRADED'}`}
            </span>
            <span className={`status-pill ${serverOnline === false ? 'bad' : ''}`}>
              {monitor?.server_id || 'VS-CORE-01'}
              {serverOnline ? ' ●' : ''}
            </span>
            {monitor && serverOnline !== false && (
              <>
                <span className={`status-pill ${isOnline(monitor.api.status) ? '' : 'bad'}`}>
                  API {monitor.api.status}
                </span>
                <span className={`status-pill ${isOnline(monitor.database.status) ? '' : 'bad'}`}>
                  DB {monitor.database.status}
                </span>
                <span
                  className={`status-pill ${
                    isOnline(monitor.redis.status)
                      ? ''
                      : monitor.redis.status === 'WARNING'
                        ? 'warn'
                        : 'bad'
                  }`}
                >
                  REDIS {monitor.redis.status}
                </span>
                <span
                  className={`status-pill ${
                    isOnline(monitor.wireguard.status)
                      ? ''
                      : monitor.wireguard.status === 'WARNING'
                        ? 'warn'
                        : 'bad'
                  }`}
                >
                  WG {monitor.wireguard.status}
                </span>
                <span className={`status-pill ${monitor.live_trading_enabled ? 'warn' : ''}`}>
                  LIVE {monitor.live_trading_enabled ? 'ON' : 'OFF'}
                </span>
              </>
            )}
          </div>

          <div className="desk-stats">
            <div className="desk-stat">
              <div className="desk-stat-label">WG CLIENTS</div>
              <div className="desk-stat-value">
                {monitor ? `${monitor.clients.online}/${monitor.clients.total}` : '—'}
              </div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">ACCOUNTS</div>
              <div className="desk-stat-value">{accounts.length}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">OPEN</div>
              <div className="desk-stat-value">{openTrades}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">FILLS</div>
              <div className="desk-stat-value up">{fills}</div>
            </div>
            <div className="desk-stat">
              <div className="desk-stat-label">CPU</div>
              <div className="desk-stat-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {monitor?.system.cpu_percent != null ? `${monitor.system.cpu_percent}%` : '—'}
              </div>
            </div>
          </div>

          <div className="header-chrome">
            <button type="button" className="btn btn-primary" onClick={() => void toggleFullscreen()}>
              {isFs ? 'EXIT FS' : 'FULL SCREEN'}
            </button>
          </div>
        </header>

        <div className="desk-body">
          <aside className="desk-rail">
            <div className="rail-section">
              <div className="rail-title rail-title-row">
                <span>ACCOUNTS ({Math.max(clients.length, clientCount(status))})</span>
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
                      <span>
                        {c.enabled ? 'ACTIVE' : 'OFF'} · {accs.length} acct
                      </span>
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
              <div className="rail-title">MARKETS</div>
              <div className="metric-value" style={{ fontSize: 14 }}>
                {markets.toLocaleString()}
              </div>
            </div>
          </aside>

          <main className="desk-main">{children}</main>
        </div>

        <footer className="footer-strip desk-footer">
          <span>
            {serverOnline === false
              ? 'SERVER OFFLINE — no live telemetry'
              : `CONNECTED // ${monitor?.server_id || 'VS-CORE-01'}`}
          </span>
          <span>ADMIN CONTROL PANEL (MSI) → i3 SERVER</span>
          <span className="footer-logo-wrap">
            <Logo size={18} />
          </span>
        </footer>
      </div>
    </DeskContext.Provider>
  );
}
