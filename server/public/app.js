'use strict';

// ---------- State ----------
const MAX_LOGS = 8000;       // full log buffer kept client-side for filtering
const MAX_DOM_ROWS = 3000;   // hard cap on rendered rows for performance
const MAX_DETAIL_CHARS = 20000; // cap on how much of one message/stack we render in the detail panel

const state = {
    logs: [],                        // all logs (capped at MAX_LOGS)
    sessions: new Map(),             // id -> session
    levels: { Log: true, Warning: true, Error: true, Assert: true, Exception: true },
    search: '',
    sessionFilter: null,             // null = all devices
    follow: true,
    paused: false,
    pendingWhilePaused: [],
};

// ---------- Elements ----------
const el = {
    serverName: document.getElementById('serverName'),
    deviceList: document.getElementById('deviceList'),
    logList: document.getElementById('logList'),
    logView: document.getElementById('logView'),
    search: document.getElementById('search'),
    btnScroll: document.getElementById('btnScroll'),
    btnPause: document.getElementById('btnPause'),
    btnWrap: document.getElementById('btnWrap'),
    btnDownload: document.getElementById('btnDownload'),
    btnClear: document.getElementById('btnClear'),
    connDot: document.getElementById('connDot'),
    connText: document.getElementById('connText'),
    countText: document.getElementById('countText'),
    filterText: document.getElementById('filterText'),
    pausedBadge: document.getElementById('pausedBadge'),
    levelFilters: document.getElementById('levelFilters'),
};

// ---------- Helpers ----------
function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function shortLevel(level) {
    // Unity emits LogType names: Log, Warning, Error, Assert, Exception
    return ({ Log: 'log', Warning: 'warn', Error: 'error', Assert: 'assert', Exception: 'except' })[level] || level;
}

function deviceLabel(session) {
    const dev = session.device || {};
    return dev.model || dev.name || session.id;
}

function passesFilter(log) {
    if (!state.levels[log.level]) {
        // Treat unknown levels as "Log" so nothing silently vanishes.
        if (!(log.level in state.levels) && !state.levels.Log) return false;
        if (log.level in state.levels) return false;
    }
    if (state.sessionFilter && log.session !== state.sessionFilter) return false;
    if (state.search) {
        const q = state.search.toLowerCase();
        if (!log.message.toLowerCase().includes(q) && !(log.stack || '').toLowerCase().includes(q)) return false;
    }
    return true;
}

// ---------- Rendering ----------
function makeRow(log) {
    const row = document.createElement('div');
    row.className = `row lvl-${log.level} expandable`;
    row.dataset.id = log.id;

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(log.t);

    const tag = document.createElement('span');
    tag.className = 'tag';
    const sess = state.sessions.get(log.session);
    tag.textContent = `${shortLevel(log.level)} · ${sess ? deviceLabel(sess) : log.session}`;

    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = log.message;

    row.appendChild(ts);
    row.appendChild(tag);
    row.appendChild(msg);

    row.addEventListener('click', () => toggleDetail(row, log));
    return row;
}

// Cap a string for display; the download endpoint always has the untruncated text.
function clipForDisplay(s) {
    if (s.length <= MAX_DETAIL_CHARS) return { text: s, truncated: 0 };
    return { text: s.slice(0, MAX_DETAIL_CHARS), truncated: s.length - MAX_DETAIL_CHARS };
}

function buildSection(labelText, fullText) {
    const section = document.createElement('div');
    section.className = 'detail-section';

    const head = document.createElement('div');
    head.className = 'detail-head';

    const label = document.createElement('span');
    label.className = 'detail-label';
    label.textContent = `${labelText} · ${fullText.length.toLocaleString()} chars`;

    const copy = document.createElement('button');
    copy.className = 'detail-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(fullText); // copies the FULL untruncated text
        copy.textContent = ok ? 'Copied' : 'Copy failed';
        copy.classList.toggle('done', ok);
        setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('done'); }, 1400);
    });

    head.appendChild(label);
    head.appendChild(copy);

    const body = document.createElement('div');
    body.className = 'detail-body';
    const { text, truncated } = clipForDisplay(fullText);
    body.textContent = text;

    section.appendChild(head);
    section.appendChild(body);

    if (truncated > 0) {
        const note = document.createElement('div');
        note.className = 'detail-note';
        note.textContent =
            `Truncated for display at ${MAX_DETAIL_CHARS.toLocaleString()} characters ` +
            `(${truncated.toLocaleString()} more). Use Copy, or Download the log file, to get all of it.`;
        section.appendChild(note);
    }
    return section;
}

function toggleDetail(row, log) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('detail')) {
        existing.remove();
        row.classList.remove('open');
        return;
    }

    const panel = document.createElement('div');
    panel.className = 'detail';
    // Clicks inside the panel (selecting text, Copy) must not toggle the row.
    panel.addEventListener('click', (e) => e.stopPropagation());

    panel.appendChild(buildSection('Message', log.message || ''));
    if (log.stack && log.stack.trim()) {
        panel.appendChild(buildSection('Stack trace', log.stack.trim()));
    }

    row.after(panel);
    row.classList.add('open');
}

async function copyText(text) {
    // navigator.clipboard needs a secure context; on a plain-http LAN it's unavailable,
    // so fall back to a temporary textarea + execCommand.
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

function nearBottom() {
    const v = el.logView;
    return v.scrollHeight - v.scrollTop - v.clientHeight < 40;
}

function scrollToBottom() {
    el.logView.scrollTop = el.logView.scrollHeight;
}

function appendLogs(logs) {
    const wasAtBottom = nearBottom();
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const log of logs) {
        if (!passesFilter(log)) continue;
        frag.appendChild(makeRow(log));
        added++;
    }
    if (added) {
        el.logList.appendChild(frag);
        trimDom();
        updateCount();
    }
    if (state.follow && (wasAtBottom || added)) scrollToBottom();
}

function trimDom() {
    // Remove oldest rows (and any attached stack panels) beyond the cap.
    let over = el.logList.children.length - MAX_DOM_ROWS;
    while (over > 0 && el.logList.firstChild) {
        el.logList.removeChild(el.logList.firstChild);
        over--;
    }
}

function rerenderAll() {
    el.logList.innerHTML = '';
    const visible = state.logs.filter(passesFilter);
    const slice = visible.slice(-MAX_DOM_ROWS);
    const frag = document.createDocumentFragment();
    for (const log of slice) frag.appendChild(makeRow(log));
    el.logList.appendChild(frag);
    updateCount();
    if (state.follow) scrollToBottom();
}

function updateCount() {
    const shown = el.logList.querySelectorAll('.row').length;
    el.countText.textContent = `${shown.toLocaleString()} shown`;
    el.filterText.textContent = state.sessionFilter
        ? (state.sessions.has(state.sessionFilter) ? deviceLabel(state.sessions.get(state.sessionFilter)) : state.sessionFilter)
        : 'all devices';
}

// ---------- Devices ----------
function renderDevices() {
    el.deviceList.innerHTML = '';
    if (state.sessions.size === 0) {
        el.deviceList.innerHTML = '<div class="empty-hint">No devices yet. Start a build with the client attached.</div>';
        return;
    }
    const list = Array.from(state.sessions.values()).sort((a, b) => b.lastSeen - a.lastSeen);

    const allBtn = document.createElement('div');
    allBtn.className = 'device' + (state.sessionFilter === null ? ' active' : '');
    allBtn.innerHTML = `<span class="dot" style="background:var(--accent)"></span>
    <div><div class="d-name">All devices</div><div class="d-meta">${list.length} connected</div></div>
    <span class="d-count"></span>`;
    allBtn.onclick = () => { state.sessionFilter = null; renderDevices(); rerenderAll(); };
    el.deviceList.appendChild(allBtn);

    for (const s of list) {
        const dev = s.device || {};
        const div = document.createElement('div');
        div.className = 'device' + (s.online ? ' online' : '') + (state.sessionFilter === s.id ? ' active' : '');
        const name = deviceLabel(s);
        const meta = [dev.platform, dev.app].filter(Boolean).join(' · ') || s.id;
        div.innerHTML = `<span class="dot"></span>
      <div><div class="d-name" title="${escapeAttr(name)}">${escapeHtml(name)}</div>
      <div class="d-meta" title="${escapeAttr(meta)}">${escapeHtml(meta)}</div></div>
      <span class="d-count">${s.count.toLocaleString()}</span>`;
        div.onclick = () => { state.sessionFilter = s.id; renderDevices(); rerenderAll(); };
        el.deviceList.appendChild(div);
    }
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

// ---------- Ingest into client state ----------
function addLogs(logs) {
    for (const log of logs) state.logs.push(log);
    // Per-device counts come from the server's 'session' messages, so we don't tally locally.
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);

    if (state.paused) {
        state.pendingWhilePaused.push(...logs);
    } else {
        appendLogs(logs);
    }
}

function upsertSession(session) {
    state.sessions.set(session.id, session);
    renderDevices();
    updateCount();
}

// ---------- WebSocket ----------
let ws = null;
let reconnectTimer = null;

function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => setConn(true);
    ws.onclose = () => { setConn(false); scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };

    ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        switch (m.type) {
            case 'snapshot':
                state.logs = m.logs || [];
                state.sessions = new Map((m.sessions || []).map((s) => [s.id, s]));
                if (m.server && m.server.name) el.serverName.textContent = m.server.name;
                renderDevices();
                rerenderAll();
                break;
            case 'logs':
                addLogs(m.logs || []);
                break;
            case 'session':
                if (m.session) upsertSession(m.session);
                break;
            case 'clear':
                state.logs = [];
                state.pendingWhilePaused = [];
                rerenderAll();
                break;
        }
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function setConn(live) {
    el.connDot.className = 'status-dot ' + (live ? 'live' : 'down');
    el.connText.textContent = live ? 'connected' : 'reconnecting…';
}

// ---------- Controls ----------
el.levelFilters.addEventListener('click', (e) => {
    const btn = e.target.closest('.lvl-toggle');
    if (!btn) return;
    const lvl = btn.dataset.level;
    state.levels[lvl] = !state.levels[lvl];
    btn.dataset.on = state.levels[lvl] ? '1' : '0';
    rerenderAll();
});

let searchTimer = null;
el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = el.search.value.trim(); rerenderAll(); }, 120);
});

el.btnScroll.addEventListener('click', () => {
    state.follow = !state.follow;
    el.btnScroll.classList.toggle('on', state.follow);
    if (state.follow) scrollToBottom();
});

el.btnPause.addEventListener('click', () => {
    state.paused = !state.paused;
    el.btnPause.classList.toggle('on', state.paused);
    el.pausedBadge.hidden = !state.paused;
    if (!state.paused && state.pendingWhilePaused.length) {
        const buffered = state.pendingWhilePaused;
        state.pendingWhilePaused = [];
        appendLogs(buffered);
    }
});

el.btnWrap.addEventListener('click', () => {
    const on = el.logList.classList.toggle('wrap');
    el.btnWrap.classList.toggle('on', on);
});

el.btnDownload.addEventListener('click', () => {
    // Downloads the complete, untruncated log for the current device scope.
    // The server sets the filename via Content-Disposition.
    const url = state.sessionFilter
        ? `/export?session=${encodeURIComponent(state.sessionFilter)}`
        : '/export';
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
});

el.btnClear.addEventListener('click', async () => {
    try { await fetch('/clear', { method: 'POST' }); } catch (e) {}
});

// If the user scrolls up, stop following; if they scroll back to the bottom, resume.
el.logView.addEventListener('scroll', () => {
    if (nearBottom() && !state.follow) {
        state.follow = true;
        el.btnScroll.classList.add('on');
    } else if (!nearBottom() && state.follow) {
        state.follow = false;
        el.btnScroll.classList.remove('on');
    }
});

// ---------- Go ----------
connect();