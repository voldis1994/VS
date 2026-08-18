const TOKEN_KEY = 'vs_admin_token';
const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  page: 'Dashboard',
  health: null,
  monitor: null,
  clients: [],
  brokers: [],
  robot: {},
  markets: [],
  accountId: null,
  brokerId: null,
  marketId: null,
  robotId: null,
};

async function api(path, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (state.token) headers['x-admin-token'] = state.token;
  const ac = opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined;
  const res = await fetch(path, {
    ...opts,
    headers,
    signal: ac,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status} ${path}`);
  return data;
}

function chip(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'chip' + (tone ? ' ' + tone : '');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showPage(name) {
  state.page = name;
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.page === name);
  });
  document.querySelectorAll('.pane').forEach((p) => {
    p.classList.toggle('on', p.id === 'pane-' + name);
  });
}

function fillSelect(id, html, fingerprint) {
  const sel = document.getElementById(id);
  if (sel.dataset.fp === fingerprint) return;
  const keep = sel.value;
  sel.innerHTML = html;
  sel.dataset.fp = fingerprint;
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function fillTable(id, html, fingerprint) {
  const tb = document.getElementById(id);
  if (tb.dataset.fp === fingerprint) return;
  tb.innerHTML = html;
  tb.dataset.fp = fingerprint;
}

function typingInForm() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = (a.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

async function bootstrap() {
  try {
    const boot = await fetch('/api/v1/admin/lan-bootstrap').then((r) => r.json());
    if (boot && boot.api_admin_token && !state.token) {
      state.token = boot.api_admin_token;
      localStorage.setItem(TOKEN_KEY, state.token);
    }
  } catch { /* paste token on Dashboard */ }
}

function paintDashboard() {
  const m = state.monitor || {};
  const feeds = m.feeds || {};
  const feedLine = Object.keys(feeds).length
    ? Object.entries(feeds).map(([k, v]) => `${k} ${(v && v.status) || v}`).join(' · ')
    : 'NO DATA';
  document.getElementById('d-sid').textContent = m.server_id || (state.health && state.health.server_id) || '—';
  document.getElementById('d-up').textContent = m.uptime_human || '—';
  document.getElementById('d-cli').textContent =
    `${(m.clients && m.clients.online) || 0} / ${(m.clients && m.clients.total) || state.clients.length}`;
  document.getElementById('d-feeds').textContent = feedLine;
}

function paintClients() {
  const rows = state.clients.map((c) => `<tr>
    <td>${esc(c.name)}</td><td>${c.access_enabled ? 'YES' : 'NO'}</td>
    <td>${esc(c.robot_status)}</td><td>${esc(c.panel_epic || '—')}</td>
    <td>${esc(c.panel_lot_size != null ? c.panel_lot_size : '—')}</td>
  </tr>`).join('') || '<tr><td colspan="5">NO DATA</td></tr>';
  fillTable('ctab', rows, rows);
}

function paintBrokers() {
  const opts = state.clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (#${c.id})</option>`).join('')
    || '<option value="">Default Client</option>';
  fillSelect('bclient', opts, opts);
  const rows = state.brokers.map((b) => `<tr data-id="${esc(b.id)}">
    <td>${esc(b.id)}</td><td>${esc(b.client_name || b.client_id)}</td>
    <td>${esc(b.broker_name)}</td><td>${esc(b.environment)}</td>
    <td>${b.enabled ? 'YES' : 'NO'}</td>
  </tr>`).join('') || '<tr><td colspan="5">NO DATA</td></tr>';
  fillTable('btab', rows, rows);
  if (state.brokerId) {
    const tr = document.querySelector(`#btab tr[data-id="${state.brokerId}"]`);
    if (tr) tr.classList.add('pick');
  }
}

function paintAccounts() {
  const accs = state.clients.filter((c) => c.account_id);
  const rows = accs.map((c) => `<tr data-id="${esc(c.account_id)}">
    <td>${esc(c.name)}</td><td>${esc(c.account_id)}</td>
    <td>${esc(c.panel_epic || 'NOT SET')}</td><td>${esc(c.panel_lot_size != null ? c.panel_lot_size : '—')}</td>
  </tr>`).join('') || '<tr><td colspan="4">NO DATA — TEST broker first</td></tr>';
  fillTable('atab', rows, rows);
  if (state.accountId) {
    const tr = document.querySelector(`#atab tr[data-id="${state.accountId}"]`);
    if (tr) tr.classList.add('pick');
  }
  const mk = (state.markets || []).slice(0, 200).map((m) => `<tr data-mid="${esc(m.instrument_id)}">
    <td>${esc(m.epic)}</td><td>${esc(m.display_name)}</td><td>${esc(m.category)}</td><td>${esc(m.min_lot)}</td>
  </tr>`).join('');
  fillTable('mtab', mk, mk);
  if (state.marketId) {
    const tr = document.querySelector(`#mtab tr[data-mid="${state.marketId}"]`);
    if (tr) tr.classList.add('pick');
  }
}

function paintRobot() {
  const accs = state.clients.filter((c) => c.account_id && c.panel_epic);
  const opts = accs.map((c) => `<option value="${c.account_id}|${esc(c.panel_epic)}|${c.panel_lot_size || 0.01}">${esc(c.name)} · ${esc(c.panel_epic)}</option>`).join('')
    || '<option>Assign EPIC on Accounts first</option>';
  fillSelect('racc', opts, opts);
  const sessions = (state.robot.sessions || []).map((s) => `<tr data-id="${esc(s.id)}">
    <td>${esc(s.id)}</td><td>${esc(s.client_name || s.account_name)}</td>
    <td>${esc(s.epic)}</td><td>${esc(s.mode)}</td><td>${esc(s.open_side || 'FLAT')}</td>
    <td>${esc((s.pending_calc && s.pending_calc.direction) || '—')}</td>
    <td>${s.running ? 'YES' : 'NO'}</td>
  </tr>`).join('') || '<tr><td colspan="7">NO DATA</td></tr>';
  fillTable('rtab', sessions, sessions);
  const chain = (state.robot.board && state.robot.board.chain) || '';
  document.getElementById('rchain').textContent = chain;
  if (state.robotId) {
    const tr = document.querySelector(`#rtab tr[data-id="${state.robotId}"]`);
    if (tr) tr.classList.add('pick');
  }
}

function paintLive() {
  paintDashboard();
  paintClients();
  paintBrokers();
  paintAccounts();
  paintRobot();
}

async function poll() {
  try {
    const health = await api('/health');
    state.health = health;
    const [monitor, clients, brokers, robot] = await Promise.all([
      api('/api/v1/server/monitor').catch(() => ({})),
      api('/api/clients').catch(() => []),
      api('/api/brokers').catch(() => []),
      api('/api/robot-desk').catch(() => ({})),
    ]);
    state.monitor = monitor;
    state.clients = Array.isArray(clients) ? clients : [];
    state.brokers = Array.isArray(brokers) ? brokers : [];
    state.robot = robot || {};
    const ok = health && health.service === 'VS-CORE';
    chip('chipState', ok ? '● CONNECTED' : '● DISCONNECTED', ok ? 'ok' : 'bad');
    const apiSt = (monitor.api || {}).status;
    chip('chipHealth', `HEALTH ${apiSt === 'ONLINE' ? 'HEALTHY' : (apiSt || '—')}`, apiSt === 'ONLINE' ? 'ok' : 'warn');
    const calcOk = robot && robot.calc && robot.calc.healthy;
    chip('chipCalc', calcOk ? 'CALC LIVE' : 'CALC WAITING', calcOk ? 'ok' : 'warn');
    chip('chipLat', 'ONE PC · MSI');
    if (!typingInForm()) paintLive();
  } catch (e) {
    chip('chipState', '● DISCONNECTED', 'bad');
    document.getElementById('d-msg').textContent = String(e.message || e);
    if (!typingInForm()) paintLive();
  }
}

function bind() {
  document.querySelectorAll('#nav button').forEach((b) => {
    b.onclick = () => showPage(b.dataset.page);
  });
  document.getElementById('saveTok').onclick = () => {
    state.token = document.getElementById('tok').value.trim();
    localStorage.setItem(TOKEN_KEY, state.token);
    document.getElementById('d-msg').textContent = 'Token saved';
    poll();
  };
  if (state.token) document.getElementById('tok').value = state.token;

  document.getElementById('ccreate').onclick = async () => {
    const name = document.getElementById('cname').value.trim();
    const box = document.getElementById('cmsg');
    try {
      const res = await api('/api/clients/provision-web', { method: 'POST', body: { name } });
      box.className = 'msg okt';
      box.textContent = `URL ${res.panel_url || res.panel_url_public || '—'}  LOGIN ${res.login}  PASSWORD ${res.password}`;
      await poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };

  document.getElementById('btab').onclick = (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    state.brokerId = Number(tr.dataset.id);
    document.querySelectorAll('#btab tr').forEach((x) => x.classList.remove('pick'));
    tr.classList.add('pick');
  };
  document.getElementById('bsave').onclick = async () => {
    const box = document.getElementById('bmsg');
    try {
      const body = {
        broker_name: document.getElementById('bbroker').value,
        environment: document.getElementById('benv').value,
        identifier: document.getElementById('bident').value.trim(),
        api_key: document.getElementById('bkey').value.trim(),
        password: document.getElementById('bpass').value.trim(),
      };
      const cid = document.getElementById('bclient').value;
      if (cid) body.client_id = Number(cid);
      await api('/api/brokers', { method: 'POST', body });
      box.className = 'msg okt';
      box.textContent = 'Saved. TEST the row, then PULL catalog on Accounts.';
      document.getElementById('bkey').value = '';
      document.getElementById('bpass').value = '';
      await poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
  document.getElementById('btest').onclick = async () => {
    const box = document.getElementById('bmsg');
    if (!state.brokerId) { box.textContent = 'Select a broker row'; return; }
    box.textContent = 'Testing…';
    try {
      const res = await api(`/api/brokers/${state.brokerId}/test`, { method: 'POST', body: {} });
      box.className = res.success ? 'msg okt' : 'msg err';
      box.textContent = res.message || res.error || JSON.stringify(res);
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };

  document.getElementById('atab').onclick = (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    state.accountId = Number(tr.dataset.id);
    document.querySelectorAll('#atab tr').forEach((x) => x.classList.remove('pick'));
    tr.classList.add('pick');
  };
  document.getElementById('mtab').onclick = (ev) => {
    const tr = ev.target.closest('tr[data-mid]');
    if (!tr) return;
    state.marketId = Number(tr.dataset.mid);
    document.querySelectorAll('#mtab tr').forEach((x) => x.classList.remove('pick'));
    tr.classList.add('pick');
  };
  const amsg = document.getElementById('amsg');
  document.getElementById('aload').onclick = async () => {
    if (!state.accountId) { amsg.textContent = 'Select account'; return; }
    const q = document.getElementById('q').value.trim();
    const path = `/api/trading/accounts/${state.accountId}/instruments` + (q ? `?q=${encodeURIComponent(q)}` : '');
    try {
      state.markets = await api(path);
      amsg.textContent = `${state.markets.length} markets`;
      paintAccounts();
    } catch (e) { amsg.textContent = String(e.message || e); }
  };
  document.getElementById('apull').onclick = async () => {
    if (!state.accountId) { amsg.textContent = 'Select account'; return; }
    amsg.textContent = 'Pulling Capital navigation (up to 3 min)…';
    try {
      const res = await api(`/api/trading/accounts/${state.accountId}/pull-capital-markets`, { method: 'POST', body: {}, timeout: 180000 });
      amsg.className = 'msg okt';
      amsg.textContent = `PULLED ${res.count} · ${res.note || ''}`;
      document.getElementById('aload').click();
    } catch (e) { amsg.className = 'msg err'; amsg.textContent = String(e.message || e); }
  };
  document.getElementById('asave').onclick = async () => {
    if (!state.accountId || !state.marketId) { amsg.textContent = 'Select account and EPIC'; return; }
    try {
      await api(`/api/trading/accounts/${state.accountId}/selected-market`, {
        method: 'PUT',
        body: { capital_market_id: state.marketId, lot_size: Number(document.getElementById('alot').value) },
      });
      amsg.className = 'msg okt';
      amsg.textContent = 'EPIC saved';
      await poll();
    } catch (e) { amsg.className = 'msg err'; amsg.textContent = String(e.message || e); }
  };

  document.getElementById('rtab').onclick = (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    state.robotId = tr.dataset.id;
    document.querySelectorAll('#rtab tr').forEach((x) => x.classList.remove('pick'));
    tr.classList.add('pick');
  };
  const rmsg = document.getElementById('rmsg');
  document.getElementById('rstart').onclick = async () => {
    const raw = document.getElementById('racc').value;
    const [account_id, epic, lot] = raw.split('|');
    try {
      const res = await api('/api/robot-desk/start', {
        method: 'POST',
        body: { account_id: Number(account_id), epic, lot_size: Number(lot), trading_enabled: true, entry_enabled: true },
      });
      rmsg.className = 'msg okt';
      rmsg.textContent = `STARTED ${(res.session && res.session.id) || epic}`;
      await poll();
    } catch (e) { rmsg.className = 'msg err'; rmsg.textContent = String(e.message || e); }
  };
  document.getElementById('rstop').onclick = async () => {
    if (!state.robotId) { rmsg.textContent = 'No robot'; return; }
    try {
      await api(`/api/robot-desk/${state.robotId}/stop`, { method: 'POST', body: {} });
      rmsg.className = 'msg okt'; rmsg.textContent = `STOPPED ${state.robotId}`;
      await poll();
    } catch (e) { rmsg.className = 'msg err'; rmsg.textContent = String(e.message || e); }
  };
}

bootstrap().then(() => {
  bind();
  poll();
  setInterval(poll, 3000);
});
