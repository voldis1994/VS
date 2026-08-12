import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSystemStatus } from '../hooks/useApi';

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/market', label: 'Market Reader' },
  { to: '/trading', label: 'Trading' },
  { to: '/evidence', label: 'Live Evidence' },
  { to: '/positions', label: 'Positions' },
  { to: '/clients', label: 'Clients' },
  { to: '/brokers', label: 'Brokers' },
  { to: '/trades', label: 'Trades' },
  { to: '/feeds', label: 'Feeds' },
  { to: '/system', label: 'System' },
  { to: '/logs', label: 'Logs' },
  { to: '/settings', label: 'Settings' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { data: status } = useSystemStatus();

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{
        width: 220, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)',
        padding: '16px 0', flexShrink: 0,
      }}>
        <div style={{ padding: '0 16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Market Reader</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Control Panel
          </div>
          {status && (
            <div style={{ marginTop: 8 }}>
              <span className="badge badge-mode">{status.mode}</span>
            </div>
          )}
        </div>
        <nav style={{ padding: '12px 8px' }}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              style={({ isActive }) => ({
                display: 'block', padding: '8px 12px', borderRadius: 6, marginBottom: 2,
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                fontSize: 14,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {children}
      </main>
    </div>
  );
}
