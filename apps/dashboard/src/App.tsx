import { ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
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
import { TradingPage } from './pages/TradingPage';
import { OrbitReaderPage } from './pages/OrbitReaderPage';
import { RobotDeskPage } from './pages/RobotDeskPage';
import { useWebSocket } from './hooks/useWebSocket';

function Desk({ children }: { children: ReactNode }) {
  return <Layout>{children}</Layout>;
}

export default function App() {
  useWebSocket();

  return (
    <Routes>
      {/* Always fullscreen — outside desk Layout; independent per client window */}
      <Route path="/robot" element={<RobotDeskPage />} />

      <Route path="/" element={<Desk><OverviewPage /></Desk>} />
      <Route path="/orbit" element={<Desk><OrbitReaderPage /></Desk>} />
      <Route path="/market" element={<Desk><MarketReaderPage /></Desk>} />
      <Route path="/trading" element={<Desk><TradingPage /></Desk>} />
      <Route path="/evidence/:instrumentId?" element={<Desk><EvidencePage /></Desk>} />
      <Route path="/positions" element={<Desk><PositionsPage /></Desk>} />
      <Route path="/clients" element={<Desk><ClientsPage /></Desk>} />
      <Route path="/brokers" element={<Desk><BrokersPage /></Desk>} />
      <Route path="/trades" element={<Desk><TradesPage /></Desk>} />
      <Route path="/feeds" element={<Desk><FeedsPage /></Desk>} />
      <Route path="/system" element={<Desk><SystemPage /></Desk>} />
      <Route path="/logs" element={<Desk><LogsPage /></Desk>} />
      <Route path="/settings" element={<Desk><SettingsPage /></Desk>} />
    </Routes>
  );
}
