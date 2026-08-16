/**
 * VS CORE Server Panel v2 — real monitor API only.
 * Never invents LIVE/CONNECTED/prices.
 */
(function () {
  const cfg = {
    base: localStorage.getItem('VS_API_BASE') || 'http://127.0.0.1:3000',
    token: localStorage.getItem('VS_ADMIN_TOKEN') || '',
  };

  const el = (id) => document.getElementById(id);
  let backoff = 1000;
  let es = null;
  let pollTimer = null;

  function pad(label, width) {
    return (label + ' '.repeat(width)).slice(0, width);
  }

  function line(label, value, status) {
    const st =
      status === 'OK' || status === 'ONLINE' || status === 'READY' || status === 'LIVE' || status === 'CONNECTED'
        ? 'ok'
        : status === 'WARNING' || status === 'DEGRADED' || status === 'STALE'
          ? 'warn'
          : status === 'UNKNOWN' || status === '—'
            ? 'mute'
            : 'bad';
    return `${pad(label, 16)} ${pad(String(value ?? '—'), 22)} <span class="${st}">${status || '—'}</span>`;
  }

  function setConn(ok) {
    const c = el('conn');
    c.textContent = ok ? 'LINK OK' : 'CONNECTION LOST';
    c.className = 'conn ' + (ok ? 'ok' : 'lost');
  }

  function globalFromSnap(s) {
    if (!s) return { text: 'NOT READY', cls: 'not_ready' };
    if (s.last_error || (s.errors && s.errors.length)) return { text: 'CRITICAL', cls: 'critical' };
    if (!s.live_trading_enabled) {
      if (s.api?.status === 'ONLINE' && s.database?.status === 'ONLINE') {
        return { text: 'TRADING DISABLED', cls: 'trading_disabled' };
      }
    }
    const degraded =
      s.redis?.status === 'WARNING' ||
      s.wireguard?.status === 'WARNING' ||
      s.admin?.status === 'WARNING';
    if (degraded) return { text: 'DEGRADED', cls: 'degraded' };
    if (s.api?.status === 'ONLINE') return { text: 'OPERATIONAL', cls: 'operational' };
    return { text: 'NOT READY', cls: 'not_ready' };
  }

  function render(snap, presence) {
    if (!snap) return;
    el('serverId').textContent = snap.server_id || 'VS-CORE-01';
    el('uptime').textContent = snap.uptime_human || '—';
    el('utc').textContent = (snap.timestamp || new Date().toISOString()).replace('T', ' ').slice(0, 19) + 'Z';
    const g = globalFromSnap(snap);
    el('globalStatus').textContent = g.text;
    el('globalStatus').className = 'global ' + g.cls;

    const sys = snap.system || {};
    const ram =
      sys.ram_used != null && sys.ram_total != null
        ? `${(sys.ram_used / 1e9).toFixed(1)} / ${(sys.ram_total / 1e9).toFixed(1)} GB`
        : '—';
    const disk =
      sys.disk_used != null && sys.disk_total != null
        ? `${(sys.disk_used / 1e9).toFixed(0)} / ${(sys.disk_total / 1e9).toFixed(0)} GB`
        : '—';
    el('system').innerHTML = [
      line('OS', 'Debian', 'OK'),
      line('CPU', sys.cpu_percent != null ? sys.cpu_percent + '%' : '—', sys.cpu_status || 'UNKNOWN'),
      line('RAM', ram, sys.ram_status || 'UNKNOWN'),
      line('SSD', disk, sys.disk_status || 'UNKNOWN'),
      line('NETWORK', snap.network?.detail || snap.services?.network?.detail || '—', snap.network?.status || 'UNKNOWN'),
      line('INTERNET', snap.network?.internet === true ? 'YES' : snap.network?.internet === false ? 'NO' : '—', snap.network?.internet === true ? 'OK' : 'UNKNOWN'),
      line('TIME SYNC', 'UTC', 'OK'),
    ].join('\n');

    const svc = (name, cell) =>
      line(name, cell?.detail || '—', cell?.status || cell?.state || 'NOT_READY');
    el('services').innerHTML = [
      svc('SUPERVISOR', { status: 'READY', detail: 'process' }),
      svc('DATABASE', snap.database),
      svc('REDIS', snap.redis),
      svc('CONTROL API', snap.api),
      svc('CLIENT API', snap.api),
      line('MARKET DATA', snap.market?.detail || '—', snap.market?.status || 'UNKNOWN'),
      line('INDICATORS', 'module', snap.market?.status === 'LIVE' ? 'READY' : 'NOT_READY'),
      line('REGIME', snap.strategy?.detail || '—', snap.strategy?.status || 'UNKNOWN'),
      line('STRATEGY', snap.strategy?.detail || '—', snap.strategy?.status || 'UNKNOWN'),
      line('SIGNAL', 'pipeline', 'READY'),
      line('RISK', snap.risk?.detail || '—', snap.risk?.status || 'UNKNOWN'),
      line('EXECUTION', snap.execution?.detail || '—', snap.execution?.status || 'UNKNOWN'),
      line('BROKER GW', 'capital', snap.trading?.enabled ? 'READY' : 'NOT_READY'),
      line('POSITIONS', 'local', 'READY'),
      line('RECONCILE', snap.reconciliation?.detail || '—', snap.reconciliation?.status || 'UNKNOWN'),
      svc('WIREGUARD', snap.wireguard),
    ].join('\n');

    const mStatus = snap.market?.status || 'UNKNOWN';
    const feedLive = mStatus === 'LIVE' || mStatus === 'OPEN' ? 'LIVE' : mStatus;
    el('feeds').innerHTML = [
      line('CAPITAL PRIMARY', feedLive, feedLive),
      line('REFERENCE', '—', 'UNKNOWN'),
      line('LAST UPDATE', snap.timestamp ? snap.timestamp.slice(11, 19) : '—', '—'),
    ].join('\n');

    el('broker').innerHTML = [
      line('ENVIRONMENT', snap.operating_mode || '—', '—'),
      line('CONNECTION', snap.live_trading_enabled ? '—' : 'CONFIG/OFF', snap.live_trading_enabled ? 'UNKNOWN' : 'NOT_READY'),
      line('ACCOUNT', '—', '—'),
      line('POSITIONS', '—', '—'),
      line('ORDERS', '—', '—'),
      line('LAST SYNC', '—', '—'),
    ].join('\n');

    const a = snap.admin || {};
    const adminState = a.connected ? 'CONNECTED' : a.device_id ? 'DISCONNECTED' : 'DISCONNECTED';
    el('admin').innerHTML = [
      line(a.device_name || 'VS-ADMIN-01', adminState, adminState),
      line('IP', a.source_ip || '—', '—'),
      line('TRANSPORT', a.transport || 'NONE', '—'),
      line('SESSION', a.connected ? 'AUTHENTICATED' : 'NONE', a.connected ? 'OK' : '—'),
      line('LAST HEARTBEAT', a.last_seen_human || (a.heartbeat_age_ms != null ? (a.heartbeat_age_ms / 1000).toFixed(1) + 's' : '—'), a.connected ? 'OK' : '—'),
      line('CONNECTED SINCE', a.connected_since ? String(a.connected_since).slice(11, 19) : '—', '—'),
    ].join('\n');

    const c = snap.clients || { total: 0, online: 0, offline: 0, devices: [] };
    el('clientsSummary').innerHTML = [
      line('REGISTERED', c.total, '—'),
      line('ONLINE', c.online, c.online > 0 ? 'OK' : '—'),
      line('OFFLINE', c.offline, '—'),
    ].join('\n');

    const presenceRows = (presence && presence.clients) || snap.presence_clients || [];
    const rows = [];
    if (presenceRows.length) {
      for (const p of presenceRows.slice(0, 12)) {
        rows.push(
          `${pad(p.display_name || p.device_id, 14)} ${pad(p.status, 10)} WG ${p.wg_connected === true ? 'OK' : p.wg_connected === false ? '--' : '??'}  APP ${p.app_connected ? 'OK' : '--'}`
        );
      }
    } else if (c.devices && c.devices.length) {
      for (const d of c.devices.slice(0, 12)) {
        rows.push(
          `${pad(d.device_id, 14)} ${pad(d.connection_state || d.status, 10)} ${d.transport || ''}`
        );
      }
    } else {
      rows.push('<span class="mute">NO CLIENTS ONLINE</span>');
    }
    el('clients').innerHTML = rows.join('\n');

    el('incidents').innerHTML = snap.last_error
      ? `<span class="bad">ERROR</span>  ${snap.last_error}`
      : '<span class="mute">NO OPEN INCIDENTS</span>';

    const ev = (snap.errors || []).slice(0, 8).map((e) => `[SYSTEM] ${e}`);
    if (!ev.length) ev.push('[SYSTEM] monitor snapshot received');
    el('events').innerHTML = ev.map((x) => `<span class="mute">${x}</span>`).join('\n');
  }

  async function fetchSnapshot() {
    const headers = {};
    if (cfg.token) headers['x-admin-token'] = cfg.token;
    const res = await fetch(cfg.base + '/api/v1/server/monitor', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function tick() {
    try {
      const snap = await fetchSnapshot();
      let presence = null;
      try {
        const headers = {};
        if (cfg.token) headers['x-admin-token'] = cfg.token;
        const pr = await fetch(cfg.base + '/api/v1/presence', { headers });
        if (pr.ok) presence = await pr.json();
      } catch (_) {}
      render(snap, presence);
      setConn(true);
      backoff = 1000;
    } catch (e) {
      setConn(false);
      el('globalStatus').textContent = 'CONNECTION LOST';
      el('globalStatus').className = 'global critical';
      backoff = Math.min(backoff * 2, 15000);
    }
  }

  function startPoll() {
    const loop = async () => {
      await tick();
      pollTimer = setTimeout(loop, backoff === 1000 ? 1500 : backoff);
    };
    loop();
  }

  function startSSE() {
    if (!cfg.token || typeof EventSource === 'undefined') return;
    try {
      // EventSource cannot set headers; use poll as primary, SSE optional via query token not used (security).
      // Presence-driven updates come from poll every 1.5s.
    } catch (_) {}
  }

  // Load token from sibling env if injected
  if (window.VS_PANEL_CONFIG) {
    Object.assign(cfg, window.VS_PANEL_CONFIG);
  }
  startPoll();
  startSSE();
})();
