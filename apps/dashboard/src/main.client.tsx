import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClientApp } from './client-v2/ClientApp';
import './client-v2/styles/aurum.css';

/** Client-only entry — AURUM desk (v2). No legacy ClientPanelPage. */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClientApp />
  </React.StrictMode>
);
