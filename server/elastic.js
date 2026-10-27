'use strict';

// Optional Elasticsearch forwarder for the remote console.
//
// Enabled only when ES_URL is set. Every log that arrives on /ingest is turned
// into an ECS-style document and bulk-indexed into a data stream (default
// "logs-unity.console-default"). Failed batches are retried with backoff; the
// in-memory queue is capped so an Elasticsearch outage can't exhaust memory.

const ES_URL = (process.env.ES_URL || '').replace(/\/+$/, '');
const ES_USER = process.env.ES_USER || '';
const ES_PASSWORD = process.env.ES_PASSWORD || '';
const ES_API_KEY = process.env.ES_API_KEY || '';
const ES_DATA_STREAM = process.env.ES_DATA_STREAM || 'logs-unity.console-default';
const ES_FLUSH_MS = parseInt(process.env.ES_FLUSH_MS || '1000', 10);
const ES_BATCH_SIZE = parseInt(process.env.ES_BATCH_SIZE || '1000', 10);
const ES_MAX_QUEUE = parseInt(process.env.ES_MAX_QUEUE || '100000', 10);

const enabled = Boolean(ES_URL);

const queue = [];
const stats = { indexed: 0, failed: 0, dropped: 0, lastError: null, lastSuccess: null };
let backoffMs = 0;
let flushing = false;

function authHeader() {
  if (ES_API_KEY) return { Authorization: `ApiKey ${ES_API_KEY}` };
  if (ES_USER) return { Authorization: 'Basic ' + Buffer.from(`${ES_USER}:${ES_PASSWORD}`).toString('base64') };
  return {};
}

// Unity LogType -> lowercase level that Kibana colours sensibly.
const LEVELS = { log: 'info', warning: 'warning', error: 'error', assert: 'assert', exception: 'exception' };

// "My Game v1.2.3" -> { name: "My Game", version: "1.2.3" }
function splitApp(app) {
  const s = String(app || '');
  const i = s.lastIndexOf(' v');
  return i > 0 ? { name: s.slice(0, i), version: s.slice(i + 2) } : { name: s || undefined, version: undefined };
}

function cleanIp(ip) {
  if (!ip) return undefined;
  return String(ip).replace(/^::ffff:/, '');
}

function toDoc(entry, session, sourceIp) {
  const d = (session && session.device) || {};
  const app = splitApp(d.app);
  const type = String(entry.level || 'Log');
  const doc = {
    '@timestamp': new Date(entry.t).toISOString(),
    message: entry.message,
    log: { level: LEVELS[type.toLowerCase()] || type.toLowerCase() },
    event: { sequence: entry.id, ingested: new Date().toISOString(), dataset: 'unity.console' },
    // Beats report host.name lowercased; match it so logs and metrics line up per machine.
    host: { name: d.name ? String(d.name).toLowerCase() : undefined, hostname: d.name || undefined },
    device: { model: { name: d.model || undefined } },
    os: { full: d.os || undefined },
    service: { name: app.name, version: app.version },
    source: { ip: cleanIp(sourceIp) },
    unity: { session: entry.session, log_type: type, version: d.unity || undefined, platform: d.platform || undefined },
  };
  if (entry.stack && entry.stack.trim()) doc.error = { stack_trace: entry.stack };
  return doc;
}

function enqueue(entries, session, sourceIp) {
  if (!enabled || !entries.length) return;
  for (const e of entries) queue.push(toDoc(e, session, sourceIp));
  if (queue.length > ES_MAX_QUEUE) {
    const n = queue.length - ES_MAX_QUEUE;
    queue.splice(0, n);
    stats.dropped += n;
  }
  if (queue.length >= ES_BATCH_SIZE && !backoffMs) flush();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, ES_BATCH_SIZE);
  let body = '';
  for (const doc of batch) body += '{"create":{}}\n' + JSON.stringify(doc) + '\n';

  try {
    const res = await fetch(`${ES_URL}/${ES_DATA_STREAM}/_bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', ...authHeader() },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) {
      // 4xx (bad auth, missing privileges): retrying won't help until config is fixed,
      // but keep the data and back off so nothing is lost while you fix it.
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const retry = [];
    let rejected = 0;
    let firstReason = null;
    if (json.errors) {
      json.items.forEach((item, i) => {
        const r = item.create || item.index || {};
        if (r.status >= 300) {
          if (r.status === 429) retry.push(batch[i]);
          else {
            rejected++;
            if (!firstReason) firstReason = r.error && (r.error.reason || r.error.type);
          }
        }
      });
    }
    stats.indexed += batch.length - retry.length - rejected;
    stats.failed += rejected;
    stats.lastSuccess = new Date().toISOString();
    if (rejected) console.warn(`[elastic] ${rejected} doc(s) rejected, e.g.: ${firstReason}`);
    if (retry.length) queue.unshift(...retry);
    backoffMs = 0;
  } catch (err) {
    queue.unshift(...batch); // put it back, oldest first
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 1000, 30000);
    stats.lastError = `${new Date().toISOString()} ${err.message}`;
    console.warn(`[elastic] bulk failed (${err.message}); ${queue.length} queued, retrying in ${backoffMs}ms`);
  } finally {
    flushing = false;
  }
}

function loop() {
  const wait = backoffMs || ES_FLUSH_MS;
  setTimeout(async () => {
    await flush();
    // Drain quickly if a backlog built up while ES was unavailable.
    while (!backoffMs && queue.length >= ES_BATCH_SIZE) await flush();
    loop();
  }, wait);
}

function start() {
  if (!enabled) {
    console.log('[elastic] ES_URL not set; Elasticsearch forwarding disabled');
    return;
  }
  console.log(`[elastic] forwarding logs to ${ES_URL}/${ES_DATA_STREAM}`);
  loop();
}

function status() {
  return { enabled, url: ES_URL || null, dataStream: ES_DATA_STREAM, queued: queue.length, ...stats };
}

module.exports = { enabled, enqueue, start, status, flush, _toDoc: toDoc };
