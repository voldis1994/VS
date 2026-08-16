import { NavLink, Route, Routes } from 'react-router-dom';
import { useAdminLive } from './hooks/useAdminLive';
import { DashboardPage } from './pages/DashboardPage';
import { ServersPage } from './pages/ServersPage';
import { ClientsPage } from './pages/ClientsPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

const NAV = [
  ['/', 'DASHBOARD'],
  ['/servers', 'SERVERS'],
  ['/clients', 'CLIENTS'],
  ['/accounts', 'ACCOUNTS'],
  ['/market', 'MARKET'],
  ['/trading', 'TRADING'],
  ['/risk', 'RISK'],
  ['/execution', 'EXECUTION'],
  ['/positions', 'POSITIONS'],
  ['/incidents', 'INCIDENTS'],
  ['/logs', 'LOGS'],
  ['/backups', 'BACKUPS'],
  ['/updates', 'UPDATES'],
  ['/settings', 'SETTINGS'],
] as const;

export function App() {
  const live = useAdminLive();
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">VS ADMIN</div>
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
          <div>
            <strong>{live.serverId}</strong>
            <span className="muted"> / Main Server</span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className={`pill ${live.connected ? 'on' : 'off'}`}>
              {live.connected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {live.adminName}
            </span>
          </div>
        </header>
        <div className="content">
          <Routes>
            <Route path="/" element={<DashboardPage live={live} />} />
            <Route path="/servers" element={<ServersPage live={live} />} />
            <Route path="/clients" element={<ClientsPage live={live} />} />
            <Route path="/accounts" element={<PlaceholderPage title="ACCOUNTS" note="Bound to real account API when data exists." />} />
            <Route path="/market" element={<PlaceholderPage title="MARKET" live={live} kind="market" />} />
            <Route path="/trading" element={<PlaceholderPage title="TRADING PIPELINE" note="MARKET → REGIME → STRATEGY → SIGNAL → RISK → EXECUTION" />} />
            <Route path="/risk" element={<PlaceholderPage title="RISK" note="Limits from server configuration only." />} />
            <Route path="/execution" element={<PlaceholderPage title="EXECUTION" note="No sample orders." />} />
            <Route path="/positions" element={<PlaceholderPage title="POSITIONS" note="NO DATA until broker positions exist." />} />
            <Route path="/incidents" element={<PlaceholderPage title="INCIDENTS" live={live} kind="incidents" />} />
            <Route path="/logs" element={<PlaceholderPage title="LOGS" note="Controlled log API only — no filesystem browse." />} />
            <Route path="/backups" element={<PlaceholderPage title="BACKUPS" note="Use SERVER backup commands / API." />} />
            <Route path="/updates" element={<PlaceholderPage title="UPDATES" note="Controlled update workflow on i3." />} />
            <Route path="/settings" element={<PlaceholderPage title="SETTINGS" note="Server address and admin identity." />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
