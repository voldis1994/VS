import { Routes, Route, NavLink } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { MarketReaderPage } from './pages/MarketReaderPage';
import { EvidencePage } from './pages/EvidencePage';
import { PositionsPage } from './pages/PositionsPage';
import { ClientsPage } from './pages/ClientsPage';
import { BrokersPage } from './pages/BrokersPage';
import { TradesPage } from './pages/TradesPage';
import { FeedsPage } from './pages/FeedsPage';
import { SystemPage } from './pages/SystemPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
  useWebSocket();

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/market" element={<MarketReaderPage />} />
        <Route path="/evidence/:instrumentId?" element={<EvidencePage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/brokers" element={<BrokersPage />} />
        <Route path="/trades" element={<TradesPage />} />
        <Route path="/feeds" element={<FeedsPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Layout>
  );
}

export { NavLink };
