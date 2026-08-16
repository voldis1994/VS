import { NavLink, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { SimplePage } from './pages/SimplePage';
import { useClientLive } from './lib/useClientLive';

export function App() {
  const live = useClientLive();
  return (
    <div className="app">
      <div className="brand">VS</div>
      <div className="sub">CONTROL PANEL</div>
      <div className={`conn ${live.connection === 'CONNECTED' ? 'ok' : 'bad'}`}>
        {live.connection}
      </div>
      <Routes>
        <Route path="/" element={<HomePage live={live} />} />
        <Route
          path="/positions"
          element={
            <SimplePage
              title="POSITIONS"
              body={live.positionsCount === 0 ? 'NO POSITIONS' : `${live.positionsCount} position(s)`}
            />
          }
        />
        <Route path="/history" element={<SimplePage title="HISTORY" body="NO DATA from server yet" />} />
        <Route
          path="/settings"
          element={
            <SimplePage
              title="SETTINGS"
              body={`Client: ${live.clientName || '—'}\nDevice: ${live.deviceId}\nVersion: client-v2\nVPN: ${live.wgHint}`}
            />
          }
        />
      </Routes>
      <nav className="nav">
        <NavLink to="/" end>
          HOME
        </NavLink>
        <NavLink to="/positions">POSITIONS</NavLink>
        <NavLink to="/history">HISTORY</NavLink>
        <NavLink to="/settings">SETTINGS</NavLink>
      </nav>
    </div>
  );
}
