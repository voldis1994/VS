import { NavLink, Route, Routes } from 'react-router-dom';
import { useAdminLive } from './hooks/useAdminLive';
import { DashboardPage } from './pages/DashboardPage';
import { ServersPage } from './pages/ServersPage';
import { ClientsPage } from './pages/ClientsPage';
import { ResourcePage } from './pages/ResourcePage';

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
