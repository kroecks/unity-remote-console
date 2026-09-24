'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---- Configuration (all overridable via environment variables) ----
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10);
const DISCOVERY_PORT = parseInt(process.env.DISCOVERY_PORT || '9999', 10);
const MAGIC = process.env.MAGIC || 'UNITY_REMOTE_CONSOLE_V1';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '5000', 10); // logs kept in memory
const OFFLINE_AFTER_MS = parseInt(process.env.OFFLINE_AFTER_MS || '10000', 10);

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- In-memory state ----
const ring = [];            // recent log entries (capped at BUFFER_SIZE)
let seq = 0;                // monotonic id for every log
const sessions = new Map(); // sessionId -> { id, device, firstSeen, lastSeen, count, online }

function pushLog(entry) {
  ring.push(entry);
  if (ring.length > BUFFER_SIZE) ring.splice(0, ring.length - BUFFER_SIZE);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

// New browser connects -> send it the current state so the view is populated.
wss.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'snapshot',
      logs: ring,
      sessions: Array.from(sessions.values()),
      server: { name: os.hostname(), bufferSize: BUFFER_SIZE },
    })
  );
});

// ---- Ingest: Unity devices POST batches here ----
app.post('/ingest', (req, res) => {
  const body = req.body || {};
  const sid = String(body.session || 'unknown');
  const device = body.device || {};
  const logs = Array.isArray(body.logs) ? body.logs : [];
  const now = Date.now();

  let s = sessions.get(sid);
  if (!s) {
    s = { id: sid, device, firstSeen: now, lastSeen: now, count: 0, online: true };
    sessions.set(sid, s);
  }
  s.lastSeen = now;
  s.device = device;
  s.online = true;
  s.count += logs.length;

  const enriched = logs.map((l) => ({
    id: ++seq,
    session: sid,
    t: Number(l.t) || now,
    level: String(l.level || 'Log'),
    message: String(l.message == null ? '' : l.message),
    stack: String(l.stack == null ? '' : l.stack),
  }));
  enriched.forEach(pushLog);

  if (enriched.length) broadcast({ type: 'logs', logs: enriched });
  broadcast({ type: 'session', session: s });

  res.json({ ok: true, received: enriched.length });
});

// ---- Clear buffer (button in the UI) ----
app.post('/clear', (req, res) => {
  ring.length = 0;
  broadcast({ type: 'clear' });
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---- Export: download the buffer as a plain-text .log file ----
function deviceDisplay(s) {
  const d = (s && s.device) || {};
  return d.model || d.name || (s && s.id) || 'device';
}

function slug(x) {
  return String(x).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'device';
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function formatLogLine(l) {
  const d = new Date(l.t);
  const ts =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  let out = `[${ts}] [${l.level}] ${l.message}`;
  if (l.stack && l.stack.trim()) {
    out += '\n' + l.stack.trim().split('\n').map((line) => '    ' + line).join('\n');
  }
  return out;
}

app.get('/export', (req, res) => {
  const sid = req.query.session ? String(req.query.session) : null;
  const items = sid ? ring.filter((l) => l.session === sid) : ring;
  const s = sid ? sessions.get(sid) : null;
  const now = new Date();

  const header = [
    '# Unity Remote Console export',
    s ? `# device: ${deviceDisplay(s)}` : '# device: all devices',
    s && s.device ? `# platform: ${s.device.platform || '?'} | app: ${s.device.app || '?'} | os: ${s.device.os || '?'}` : null,
    sid ? `# session: ${sid}` : null,
    `# exported: ${now.toISOString()}`,
    `# entries: ${items.length}`,
    '# ----------------------------------------------------------------------',
    '',
  ].filter((x) => x !== null).join('\n');

  const text = header + items.map(formatLogLine).join('\n') + (items.length ? '\n' : '');

  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const scope = s ? slug(deviceDisplay(s)) : 'all-devices';
  const fname = `unity-logs_${scope}_${stamp}.log`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(text);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Presence sweeper: flip sessions offline when they stop reporting ----
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    const online = now - s.lastSeen < OFFLINE_AFTER_MS;
    if (online !== s.online) {
      s.online = online;
      broadcast({ type: 'session', session: s });
    }
  }
}, 2000);

// ---- UDP discovery responder ----
// The Unity client broadcasts "<MAGIC>:DISCOVER"; we reply (unicast) with our details.
const disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
disco.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8');
  if (!text.startsWith(MAGIC)) return;
  const reply = JSON.stringify({
    service: 'unity-remote-console',
    magic: MAGIC,
    http: HTTP_PORT,
    name: os.hostname(),
  });
  disco.send(reply, rinfo.port, rinfo.address, () => {});
});
disco.on('listening', () => {
  try { disco.setBroadcast(true); } catch (e) { /* ignore */ }
  console.log(`[discovery] listening on udp/${DISCOVERY_PORT}`);
});
disco.on('error', (err) => {
  console.error('[discovery] socket error:', err.message);
});
disco.bind(DISCOVERY_PORT);

// ---- Start ----
server.listen(HTTP_PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log(`Unity Remote Console`);
  console.log(`  HTTP + WebSocket : http://0.0.0.0:${HTTP_PORT}`);
  console.log(`  Discovery (UDP)  : ${DISCOVERY_PORT}`);
  console.log(`  Open the UI at   : ${addrs.map((a) => `http://${a}:${HTTP_PORT}`).join('  ') || `http://localhost:${HTTP_PORT}`}`);
});
