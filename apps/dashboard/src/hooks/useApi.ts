import { useState, useEffect, useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

export function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  }).then(async (res) => {
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  });
}

export function useApi<T>(path: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    apiFetch<T>(path)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    refresh();
    if (intervalMs > 0) {
      const id = setInterval(refresh, intervalMs);
      return () => clearInterval(id);
    }
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}

export function useSystemStatus() {
  return useApi<{
    market_core: string;
    execution: string;
    database: string;
    mode: string;
    feeds: { active: number; unhealthy: number };
    open_positions: number;
    today_executions: number;
  }>('/api/system/status', 5000);
}
