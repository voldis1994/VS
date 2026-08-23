import { Routes, Route } from 'react-router-dom';
import { CommandApp } from './admin-v2/CommandApp';
import { useWebSocket } from './hooks/useWebSocket';

/** Admin desk app (port 5173). Client share URL uses main.client.tsx instead. */
export default function App() {
  useWebSocket();

  return (
    <Routes>
      <Route path="/*" element={<CommandApp />} />
    </Routes>
  );
}
