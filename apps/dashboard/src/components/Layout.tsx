import { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSystemStatus } from '../hooks/useApi';
import { Logo } from './Logo';

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/market', label: 'Markets' },
  { to: '/trading', label: 'Trading' },
  { to: '/evidence', label: 'Evidence' },
  { to: '/positions', label: 'Positions' },
  { to: '/clients', label: 'Accounts' },
  { to: '/brokers', label: 'Brokers' },
  { to: '/trades', label: 'Fills' },
  { to: '/feeds', label: 'Feeds' },
  { to: '/system', label: 'System' },
  { to: '/logs', label: 'Audit' },
  { to: '/settings', label: 'Settings' },
];

const TITLES: Record<string, string> = {
  '/': 'Command Overview',
  '/market': 'Market Reader',
  '/trading': 'Trade Desk',
  '/evidence': 'Live Evidence',
  '/positions': 'Open Risk',
  '/clients': 'Accounts',
  '/brokers': 'Broker Links',
  '/trades': 'Fill History',
  '/feeds': 'Feed Health',
  '/system': 'System Telemetry',
  '/logs': 'Audit Trail',
  '/settings': 'Desk Settings',
};

export function Layout({ children }: { children: ReactNode }) {
  const { data: status } = useSystemStatus();
  const loc = useLocation();
  const title =
    TITLES[loc.pathname] ||
    (loc.pathname.startsWith('/evidence') ? 'Live Evidence' : 'Control Panel');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div className="brand-text">
            <div className="brand-title">MARKET READER</div>
            <div className="brand-sub">Prop Desk // Neon</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          MODE {status?.mode ?? '—'} · CORE {status?.market_core ?? '—'}
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="topbar-title">{title}</div>
          <div className="actions">
            {status && <span className="badge badge-mode">{status.mode}</span>}
            <span className="live-chip">Live Desk</span>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
