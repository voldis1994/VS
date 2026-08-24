import { NavLink, Outlet } from 'react-router-dom';
import { useCommandDesk } from './context/CommandDeskContext';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/robot', label: 'Robots' },
  { to: '/multi-market', label: 'Multi' },
  { to: '/clients', label: 'Clients' },
  { to: '/market', label: 'Regimes' },
  { to: '/trading', label: 'Trading' },
  { to: '/brokers', label: 'Brokers' },
  { to: '/feeds', label: 'Feeds' },
  { to: '/positions', label: 'Positions' },
  { to: '/system', label: 'System' },
];

export function CommandShell() {
  const { status, clients } = useCommandDesk();
  const mode = String(status?.mode || '—').toUpperCase();
  const live = status?.live_enabled ? 'LIVE' : 'PARKED';

  return (
    <div className="cmd-app">
      <aside className="cmd-rail">
        <div className="cmd-brand">
          <div className="cmd-brand-glyph" aria-hidden />
          <div>
            <div className="cmd-brand-name">COMMAND</div>
            <div className="cmd-brand-sub">VS · operator</div>
          </div>
        </div>

        <nav className="cmd-nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `cmd-nav-link ${isActive ? 'on' : ''}`}
            >
              {n.label}
            </NavLink>
          ))}
          <NavLink to="/client" className="cmd-nav-link cmd-nav-link--client">
            Client preview
          </NavLink>
        </nav>

        <div className="cmd-rail-foot">
          <div className="cmd-pill">{mode}</div>
          <div className={`cmd-pill ${status?.live_enabled ? 'live' : ''}`}>{live}</div>
          <div className="cmd-rail-meta">{clients.length} clients</div>
        </div>
      </aside>

      <div className="cmd-stage">
        <Outlet />
      </div>
    </div>
  );
}
