/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_CLIENT_WS_URL: string;
  readonly VITE_APP_MODE?: string;
  readonly VITE_CLIENT_PANEL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
