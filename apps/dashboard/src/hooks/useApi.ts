import { useState, useEffect, useCallback } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';
const ADMIN_TOKEN = String(import.meta.env.VITE_ADMIN_TOKEN || '').trim();

function extractErrorMessage(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const message = typeof o.message === 'string' ? o.message : '';
    const error = typeof o.error === 'string' ? o.error : '';
    // Prefer Fastify `message` when `error` is generic ("Bad Request")
    if (message && (!error || /^bad request$/i.test(error) || message.length > error.length)) {
      return message;
    }
    if (error) return error;
  }
  if (typeof body === 'string' && body.trim()) return body;
  return statusText || `API error: ${status}`;
}

export function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((options?.headers as Record<string, string> | undefined) || {}),
  };

  if (ADMIN_TOKEN && !headers['x-admin-token'] && !headers['X-Admin-Token']) {
    headers['x-admin-token'] = ADMIN_TOKEN;
  }

  // Avoid Fastify 400: Content-Type application/json with empty body
  if (options?.body !== undefined && options?.body !== null) {
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  const parentSignal = options?.signal;
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  return fetch(`${API_URL}${path}`, {
    ...options,
    signal: ctrl.signal,
    headers,
  })
    .then(async (res) => {
      const text = await res.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!res.ok) {
        throw new Error(extractErrorMessage(body, res.status, res.statusText));
      }
      return body as T;
    })
    .catch((e) => {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('API timeout — dati neatjaunojas');
      }
      throw e;
    })
    .finally(() => clearTimeout(timer));
}

export function useApi<T>(path: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
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
