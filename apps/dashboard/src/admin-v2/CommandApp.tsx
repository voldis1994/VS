import { Routes, Route } from 'react-router-dom';
import { CommandShell } from './CommandShell';
import { CommandDeskProvider } from './context/CommandDeskContext';
import { OverviewView } from './views/OverviewView';
import { RobotView } from './views/RobotView';
import { ClientsView } from './views/ClientsView';
import { MarketView } from './views/MarketView';
import { TradingView } from './views/TradingView';
import { BrokersView } from './views/BrokersView';
import { FeedsView } from './views/FeedsView';
import { PositionsView } from './views/PositionsView';
import { SystemView } from './views/SystemView';
import { ClientApp } from '../client-v2/ClientApp';
import './styles/command.css';

/** Admin COMMAND desk (port 5173). */
export function CommandApp() {
  return (
    <CommandDeskProvider>
      <Routes>
        <Route path="/client" element={<ClientApp />} />
        <Route element={<CommandShell />}>
          <Route index element={<OverviewView />} />
          <Route path="robot" element={<RobotView />} />
          <Route path="clients" element={<ClientsView />} />
          <Route path="market" element={<MarketView />} />
          <Route path="trading" element={<TradingView />} />
          <Route path="brokers" element={<BrokersView />} />
          <Route path="feeds" element={<FeedsView />} />
          <Route path="positions" element={<PositionsView />} />
          <Route path="system" element={<SystemView />} />
        </Route>
      </Routes>
    </CommandDeskProvider>
  );
}
