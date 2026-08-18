const PAGES = ['Dashboard', 'Clients', 'Brokers', 'Accounts', 'Robot'];
const state = {
  token: '',
  page: 'Dashboard',
  health: null,
  monitor: null,
  clients: [],
  brokers: [],
  robot: {},
  msg: '',
  markets: [],
  accountId: null,
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

async function bootstrap() {
  try {
    const boot = await fetch('/api/v1/admin/lan-bootstrap').then((r) => r.json());
    if (boot && boot.api_admin_token) state.token = boot.api_admin_token;
  } catch { /* paste token below */ }
}

function chip(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'chip' + (tone ? ' ' + tone : '');
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
    render();
  } catch (e) {
    chip('chipState', '● DISCONNECTED', 'bad');
    state.msg = String(e.message || e);
    render();
  }
}

function el(html) {
  document.getElementById('view').innerHTML = html;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderNav() {
  document.getElementById('nav').innerHTML = PAGES.map(
    (p) => `<button class="${state.page === p ? 'on' : ''}" data-page="${p}">${p.toUpperCase()}</button>`
  ).join('');
  document.querySelectorAll('#nav button').forEach((b) => {
    b.onclick = () => { state.page = b.dataset.page; render(); };
  });
}

function dashboard() {
  const m = state.monitor || {};
  const feeds = m.feeds || {};
  const feedLine = Object.keys(feeds).length
    ? Object.entries(feeds).map(([k, v]) => `${k} ${(v && v.status) || v}`).join(' · ')
    : 'NO DATA';
  el(`<h1>DASHBOARD</h1>
    <div class="note">Viss uz šī MSI. C++ calc izlemj EntryReady. Robot ir Capital rokas. Klients: šī paša adrese bez /admin.</div>
    <p>server_id ${esc(m.server_id || (state.health && state.health.server_id) || '—')}</p>
    <p>uptime ${esc(m.uptime_human || '—')}</p>
    <p>clients ${(m.clients && m.clients.online) || 0} / ${(m.clients && m.clients.total) || state.clients.length}</p>
    <p>feeds ${esc(feedLine)}</p>
    <p class="msg">${esc(state.msg)}</p>
    <div class="row">
      <input id="tok" placeholder="admin token ja bootstrap neizdevās" style="min-width:280px" />
      <button class="act pri" id="saveTok">SAVE TOKEN</button>
    </div>`);
  document.getElementById('saveTok').onclick = () => {
    state.token = document.getElementById('tok').value.trim();
    poll();
  };
}

function clientsPage() {
  const rows = state.clients.map((c) => `<tr>
    <td>${esc(c.name)}</td><td>${c.access_enabled ? 'YES' : 'NO'}</td>
    <td>${esc(c.robot_status)}</td><td>${esc(c.panel_epic || '—')}</td>
    <td>${esc(c.panel_lot_size != null ? c.panel_lot_size : '—')}</td>
  </tr>`).join('');
  el(`<h1>CLIENTS</h1>
    <div class="note">Web login uz klienta adresi (tas pats :3000 bez /admin). Parole rādās vienreiz.</div>
    <div class="row">
      <input id="cname" placeholder="login name" />
      <button class="act pri" id="ccreate">CREATE WEB LOGIN</button>
    </div>
    <p class="msg" id="cmsg"></p>
    <table><thead><tr><th>LOGIN</th><th>ACCESS</th><th>ROBOT</th><th>EPIC</th><th>LOT</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">NO DATA</td></tr>'}</tbody></table>`);
  document.getElementById('ccreate').onclick = async () => {
    const name = document.getElementById('cname').value.trim();
    const box = document.getElementById('cmsg');
    try {
      const res = await api('/api/clients/provision-web', { method: 'POST', body: { name } });
      box.className = 'msg okt';
      box.textContent = `URL ${res.panel_url || res.panel_url_public || '—'}  LOGIN ${res.login}  PASSWORD ${res.password}`;
      poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
}

function brokersPage() {
  const opts = state.clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (#${c.id})</option>`).join('');
  const rows = state.brokers.map((b) => `<tr data-id="${esc(b.id)}">
    <td>${esc(b.id)}</td><td>${esc(b.client_name || b.client_id)}</td>
    <td>${esc(b.broker_name)}</td><td>${esc(b.environment)}</td>
    <td>${b.enabled ? 'YES' : 'NO'}</td>
  </tr>`).join('');
  el(`<h1>BROKERS</h1>
    <div class="note">Capital.com Live/Demo. SAVE + TEST. Katalogs ir Accounts.</div>
    <div class="row">
      <select id="bclient">${opts || '<option value="">Default Client</option>'}</select>
      <select id="bbroker"><option>capital_com</option><option>paper</option></select>
      <select id="benv"><option>demo</option><option>live</option></select>
      <input id="bident" placeholder="login email" />
      <input id="bkey" type="password" placeholder="API key" />
      <input id="bpass" type="password" placeholder="API password" />
      <button class="act pri" id="bsave">SAVE</button>
      <button class="act" id="btest">TEST SELECTED</button>
    </div>
    <p class="msg" id="bmsg"></p>
    <table><thead><tr><th>ID</th><th>CLIENT</th><th>BROKER</th><th>ENV</th><th>ON</th></tr></thead>
    <tbody id="btab">${rows || '<tr><td colspan="5">NO DATA</td></tr>'}</tbody></table>`);
  let selected = null;
  document.querySelectorAll('#btab tr[data-id]').forEach((tr) => {
    tr.onclick = () => { selected = Number(tr.dataset.id); document.querySelectorAll('#btab tr').forEach((x) => { x.style.outline = ''; }); tr.style.outline = '1px solid #2ef28a'; };
  });
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
      poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
  document.getElementById('btest').onclick = async () => {
    const box = document.getElementById('bmsg');
    if (!selected) { box.textContent = 'Select a broker row'; return; }
    box.textContent = 'Testing…';
    try {
      const res = await api(`/api/brokers/${selected}/test`, { method: 'POST', body: {} });
      box.className = res.success ? 'msg okt' : 'msg err';
      box.textContent = res.message || res.error || JSON.stringify(res);
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
}

function accountsPage() {
  const accs = state.clients.filter((c) => c.account_id);
  const rows = accs.map((c) => `<tr data-id="${esc(c.account_id)}">
    <td>${esc(c.name)}</td><td>${esc(c.account_id)}</td>
    <td>${esc(c.panel_epic || 'NOT SET')}</td><td>${esc(c.panel_lot_size != null ? c.panel_lot_size : '—')}</td>
  </tr>`).join('');
  const mk = (state.markets || []).slice(0, 200).map((m) => `<tr data-mid="${esc(m.instrument_id)}">
    <td>${esc(m.epic)}</td><td>${esc(m.display_name)}</td><td>${esc(m.category)}</td><td>${esc(m.min_lot)}</td>
  </tr>`).join('');
  el(`<h1>ACCOUNTS</h1>
    <div class="note">Izvēlies kontu → PULL CAPITAL (līdz 3 min) → meklē EPIC → SAVE EPIC.</div>
    <table><thead><tr><th>CLIENT</th><th>ACCOUNT</th><th>EPIC</th><th>LOT</th></tr></thead>
    <tbody id="atab">${rows || '<tr><td colspan="4">NO DATA — TEST broker first</td></tr>'}</tbody></table>
    <div class="row" style="margin-top:12px">
      <input id="q" placeholder="Search EPIC or name" />
      <button class="act" id="aload">LOAD CATALOG</button>
      <button class="act pri" id="apull">PULL CAPITAL</button>
      <input id="alot" type="number" step="0.01" value="0.01" />
      <button class="act pri" id="asave">SAVE EPIC</button>
    </div>
    <p class="msg" id="amsg"></p>
    <table><thead><tr><th>EPIC</th><th>NAME</th><th>CAT</th><th>MIN LOT</th></tr></thead>
    <tbody id="mtab">${mk || ''}</tbody></table>`);
  let marketId = null;
  document.querySelectorAll('#atab tr[data-id]').forEach((tr) => {
    tr.onclick = () => {
      state.accountId = Number(tr.dataset.id);
      document.querySelectorAll('#atab tr').forEach((x) => { x.style.outline = ''; });
      tr.style.outline = '1px solid #2ef28a';
    };
  });
  document.querySelectorAll('#mtab tr[data-mid]').forEach((tr) => {
    tr.onclick = () => {
      marketId = Number(tr.dataset.mid);
      document.querySelectorAll('#mtab tr').forEach((x) => { x.style.outline = ''; });
      tr.style.outline = '1px solid #2ef28a';
    };
  });
  const box = document.getElementById('amsg');
  document.getElementById('aload').onclick = async () => {
    if (!state.accountId) { box.textContent = 'Select account'; return; }
    const q = document.getElementById('q').value.trim();
    const path = `/api/trading/accounts/${state.accountId}/instruments` + (q ? `?q=${encodeURIComponent(q)}` : '');
    try {
      state.markets = await api(path);
      box.textContent = `${state.markets.length} markets`;
      render();
    } catch (e) { box.textContent = String(e.message || e); }
  };
  document.getElementById('apull').onclick = async () => {
    if (!state.accountId) { box.textContent = 'Select account'; return; }
    box.textContent = 'Pulling Capital navigation (up to 3 min)…';
    try {
      const res = await api(`/api/trading/accounts/${state.accountId}/pull-capital-markets`, { method: 'POST', body: {}, timeout: 180000 });
      box.className = 'msg okt';
      box.textContent = `PULLED ${res.count} · ${res.note || ''}`;
      document.getElementById('aload').click();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
  document.getElementById('asave').onclick = async () => {
    if (!state.accountId || !marketId) { box.textContent = 'Select account and EPIC'; return; }
    try {
      await api(`/api/trading/accounts/${state.accountId}/selected-market`, {
        method: 'PUT',
        body: { capital_market_id: marketId, lot_size: Number(document.getElementById('alot').value) },
      });
      box.className = 'msg okt';
      box.textContent = 'EPIC saved';
      poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
}

function robotPage() {
  const accs = state.clients.filter((c) => c.account_id && c.panel_epic);
  const opts = accs.map((c) => `<option value="${c.account_id}|${esc(c.panel_epic)}|${c.panel_lot_size || 0.01}">${esc(c.name)} · ${esc(c.panel_epic)}</option>`).join('');
  const sessions = (state.robot.sessions || []).map((s) => `<tr data-id="${esc(s.id)}">
    <td>${esc(s.id)}</td><td>${esc(s.client_name || s.account_name)}</td>
    <td>${esc(s.epic)}</td><td>${esc(s.mode)}</td><td>${esc(s.open_side || 'FLAT')}</td>
    <td>${esc((s.pending_calc && s.pending_calc.direction) || '—')}</td>
    <td>${s.running ? 'YES' : 'NO'}</td>
  </tr>`).join('');
  const chain = (state.robot.board && state.robot.board.chain) || '';
  el(`<h1>ROBOT</h1>
    <div class="note">START = Capital rokas. C++ calc sūta EntryReady. STOP = jauni ieejas slēgti.</div>
    <div class="row">
      <select id="racc">${opts || '<option>Assign EPIC on Accounts first</option>'}</select>
      <button class="act pri" id="rstart">START</button>
      <button class="act" id="rstop">STOP</button>
    </div>
    <p class="msg">${esc(chain)}</p>
    <p class="msg" id="rmsg"></p>
    <table><thead><tr><th>ID</th><th>CLIENT</th><th>EPIC</th><th>MODE</th><th>SIDE</th><th>CALC</th><th>RUN</th></tr></thead>
    <tbody id="rtab">${sessions || '<tr><td colspan="7">NO DATA</td></tr>'}</tbody></table>`);
  let sid = (state.robot.sessions && state.robot.sessions[0] && state.robot.sessions[0].id) || null;
  document.querySelectorAll('#rtab tr[data-id]').forEach((tr) => {
    tr.onclick = () => { sid = tr.dataset.id; };
  });
  const box = document.getElementById('rmsg');
  document.getElementById('rstart').onclick = async () => {
    const raw = document.getElementById('racc').value;
    const [account_id, epic, lot] = raw.split('|');
    try {
      const res = await api('/api/robot-desk/start', {
        method: 'POST',
        body: { account_id: Number(account_id), epic, lot_size: Number(lot), trading_enabled: true, entry_enabled: true },
      });
      box.className = 'msg okt';
      box.textContent = `STARTED ${(res.session && res.session.id) || epic}`;
      poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
  document.getElementById('rstop').onclick = async () => {
    if (!sid) { box.textContent = 'No robot'; return; }
    try {
      await api(`/api/robot-desk/${sid}/stop`, { method: 'POST', body: {} });
      box.className = 'msg okt'; box.textContent = `STOPPED ${sid}`;
      poll();
    } catch (e) { box.className = 'msg err'; box.textContent = String(e.message || e); }
  };
}

function render() {
  renderNav();
  if (state.page === 'Dashboard') dashboard();
  else if (state.page === 'Clients') clientsPage();
  else if (state.page === 'Brokers') brokersPage();
  else if (state.page === 'Accounts') accountsPage();
  else robotPage();
}

bootstrap().then(() => { render(); poll(); setInterval(poll, 3000); });
