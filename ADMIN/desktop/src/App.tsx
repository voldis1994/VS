import { NavLink, Route, Routes } from 'react-router-dom';
import { useAdminLive } from './hooks/useAdminLive';
import { DashboardPage } from './pages/DashboardPage';
import { ServersPage } from './pages/ServersPage';
import { ClientsPage } from './pages/ClientsPage';
import { ResourcePage } from './pages/ResourcePage';

const NAV = [
  ['/', 'Dashboard'],
  ['/servers', 'Servers'],
  ['/clients', 'Clients'],
  ['/accounts', 'Accounts'],
  ['/market', 'Market'],
  ['/trading', 'Trading'],
  ['/risk', 'Risk'],
  ['/execution', 'Execution'],
  ['/positions', 'Positions'],
  ['/incidents', 'Incidents'],
  ['/logs', 'Logs'],
  ['/backups', 'Backups'],
  ['/updates', 'Updates'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const live = useAdminLive();
  const hb =
    live.heartbeatAgeSec == null
      ? 'Heartbeat: —'
      : `Heartbeat: ${live.heartbeatAgeSec}s ago`;
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">VS ADMIN</div>
        <div className="muted" style={{ fontSize: 10, letterSpacing: '0.14em', margin: '0 8px 14px' }}>
          CONTROL PANEL
        </div>
        <nav className="nav">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="brand-mark">VS</span>
            <div>
              <div className="topbar-title">VS ADMIN</div>
              <div className="muted" style={{ fontSize: 11 }}>
                Server: <strong>{live.serverId}</strong>
                <span> · selector: Main</span>
              </div>
            </div>
          </div>
          <div className="topbar-right">
            <span className={`pill ${live.connected ? 'on' : 'off'}`}>
              {live.connected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
            <span className="pill">TRANSPORT: {live.transport}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {hb}
            </span>
            <span className="pill">{live.adminName}</span>
            <NavLink to="/incidents" className="topbar-link">
              Notifications
            </NavLink>
            <NavLink to="/settings" className="topbar-link">
              Settings
            </NavLink>
          </div>
        </header>
        <div className="content">
          <Routes>
            <Route path="/" element={<DashboardPage live={live} />} />
            <Route path="/servers" element={<ServersPage live={live} />} />
            <Route path="/clients" element={<ClientsPage live={live} />} />
            <Route path="/accounts" element={<ResourcePage title="ACCOUNTS" live={live} kind="accounts" />} />
            <Route path="/market" element={<ResourcePage title="MARKET" live={live} kind="market" />} />
            <Route path="/trading" element={<ResourcePage title="TRADING PIPELINE" live={live} kind="trading" />} />
            <Route path="/risk" element={<ResourcePage title="RISK" live={live} kind="risk" />} />
            <Route path="/execution" element={<ResourcePage title="EXECUTION" live={live} kind="execution" />} />
            <Route path="/positions" element={<ResourcePage title="POSITIONS" live={live} kind="positions" />} />
            <Route path="/incidents" element={<ResourcePage title="INCIDENTS" live={live} kind="incidents" />} />
            <Route path="/logs" element={<ResourcePage title="LOGS" live={live} kind="logs" />} />
            <Route path="/backups" element={<ResourcePage title="BACKUPS" live={live} kind="backups" />} />
            <Route path="/updates" element={<ResourcePage title="UPDATES" live={live} kind="updates" />} />
            <Route path="/settings" element={<ResourcePage title="SETTINGS" live={live} kind="settings" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
