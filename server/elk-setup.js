'use strict';

// One-shot bootstrap for the ELK host stack. Safe to re-run: every call is idempotent.
//
//   node elk-setup.js elasticsearch   -> passwords, roles, users, retention, Unity index template
//   node elk-setup.js kibana          -> Unity data view + saved searches in Kibana

const MODE = process.argv[2];
const ES_URL = (process.env.ES_URL || 'http://localhost:9200').replace(/\/+$/, '');
const KIBANA_URL = (process.env.KIBANA_URL || 'http://localhost:5601').replace(/\/+$/, '');
const ELASTIC_PASSWORD = req('ELASTIC_PASSWORD');
const LOG_RETENTION = process.env.LOG_RETENTION || '30d';
const METRICS_RETENTION = process.env.METRICS_RETENTION || '14d';
const DATA_STREAM_PREFIX = 'logs-unity.';

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[setup] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const auth = 'Basic ' + Buffer.from(`elastic:${ELASTIC_PASSWORD}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, method, path, body, extraHeaders = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const es = (method, path, body) => call(ES_URL, method, path, body);
const kb = (method, path, body) => call(KIBANA_URL, method, path, body, { 'kbn-xsrf': 'true', 'elastic-api-version': '2023-10-31' });

async function waitFor(label, fn, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}: ${lastErr}`);
}

function step(msg) { console.log(`[setup] ${msg}`); }

// ---------------------------------------------------------------------------
async function setupElasticsearch() {
  const KIBANA_SYSTEM_PASSWORD = req('KIBANA_SYSTEM_PASSWORD');
  const SHIPPER_PASSWORD = req('SHIPPER_PASSWORD');

  step(`waiting for Elasticsearch at ${ES_URL}`);
  await waitFor('Elasticsearch', async () => {
    const h = await es('GET', '/_cluster/health');
    return h.status === 'green' || h.status === 'yellow';
  });

  step('setting kibana_system password');
  await es('POST', '/_security/user/kibana_system/_password', { password: KIBANA_SYSTEM_PASSWORD });

  // One low-privilege account used by every shipper (Metricbeat, Filebeat, the Unity console).
  // It can append documents but cannot read, delete or change anything.
  step('creating role + user "shipper"');
  await es('PUT', '/_security/role/shipper', {
    cluster: ['monitor', 'read_ilm', 'read_pipeline'],
    indices: [
      {
        names: ['metricbeat-*', 'filebeat-*', `${DATA_STREAM_PREFIX}*`],
        privileges: ['create_doc', 'auto_configure', 'view_index_metadata'],
      },
    ],
  });
  await es('PUT', '/_security/user/shipper', {
    password: SHIPPER_PASSWORD,
    roles: ['shipper'],
    full_name: 'Log + metric shipper',
  });

  // Retention for Beats data. Created before Beats' own setup runs; Beats will not
  // overwrite an existing policy (setup.ilm.overwrite defaults to false).
  for (const beat of ['metricbeat', 'filebeat']) {
    const retention = beat === 'metricbeat' ? METRICS_RETENTION : LOG_RETENTION;
    step(`ILM policy "${beat}": roll over daily, delete after ${retention}`);
    await es('PUT', `/_ilm/policy/${beat}`, {
      policy: {
        phases: {
          hot: { actions: { rollover: { max_age: '1d', max_primary_shard_size: '10gb' } } },
          delete: { min_age: retention, actions: { delete: {} } },
        },
      },
    });
  }

  step(`index template for ${DATA_STREAM_PREFIX}* (retention ${LOG_RETENTION})`);
  await es('PUT', '/_index_template/logs-unity', {
    index_patterns: [`${DATA_STREAM_PREFIX}*-*`],
    priority: 500, // above the built-in logs-*-* template (priority 100)
    data_stream: {},
    template: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      lifecycle: { data_retention: LOG_RETENTION },
      mappings: {
        dynamic_templates: [
          { strings_as_keyword: { match_mapping_type: 'string', mapping: { type: 'keyword', ignore_above: 1024 } } },
        ],
        properties: {
          '@timestamp': { type: 'date' },
          message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
          log: { properties: { level: { type: 'keyword' } } },
          error: { properties: { stack_trace: { type: 'text' } } },
          event: {
            properties: {
              sequence: { type: 'long' },
              ingested: { type: 'date' },
              dataset: { type: 'keyword' },
            },
          },
          host: { properties: { name: { type: 'keyword' }, hostname: { type: 'keyword' } } },
          device: { properties: { model: { properties: { name: { type: 'keyword' } } } } },
          os: { properties: { full: { type: 'keyword' } } },
          service: { properties: { name: { type: 'keyword' }, version: { type: 'keyword' } } },
          source: { properties: { ip: { type: 'ip' } } },
          unity: {
            properties: {
              session: { type: 'keyword' },
              log_type: { type: 'keyword' },
              version: { type: 'keyword' },
              platform: { type: 'keyword' },
            },
          },
          data_stream: {
            properties: {
              type: { type: 'constant_keyword' },
              dataset: { type: 'constant_keyword' },
              namespace: { type: 'constant_keyword' },
            },
          },
        },
      },
    },
    _meta: { description: 'Unity remote console logs', managed_by: 'elk-setup.js' },
  });

  // If the data stream already exists (re-run after changing LOG_RETENTION), apply the new retention.
  try {
    await es('PUT', `/_data_stream/${DATA_STREAM_PREFIX}*/_lifecycle`, { data_retention: LOG_RETENTION });
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  step('Elasticsearch setup complete');
}

// ---------------------------------------------------------------------------
function savedSearch(title, query, columns) {
  return {
    attributes: {
      title,
      columns,
      sort: [['@timestamp', 'desc']],
      kibanaSavedObjectMeta: {
        searchSourceJSON: JSON.stringify({
          query: { query, language: 'kuery' },
          filter: [],
          indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        }),
      },
    },
    references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'unity-logs' }],
  };
}

async function setupKibana() {
  step(`waiting for Kibana at ${KIBANA_URL}`);
  await waitFor('Kibana', async () => {
    const s = await kb('GET', '/api/status');
    return s && s.status && s.status.overall && s.status.overall.level === 'available';
  });

  step('data view "Unity logs" (logs-unity.*)');
  await kb('POST', '/api/data_views/data_view', {
    override: true,
    data_view: {
      id: 'unity-logs',
      name: 'Unity logs',
      title: `${DATA_STREAM_PREFIX}*`,
      timeFieldName: '@timestamp',
    },
  });
  await kb('POST', '/api/data_views/default', { data_view_id: 'unity-logs', force: true });

  const cols = ['host.name', 'log.level', 'message'];
  const searches = [
    ['unity-logs-all', 'Unity - all logs', ''],
    ['unity-logs-errors', 'Unity - errors & exceptions', 'log.level : ("error" or "exception" or "assert")'],
    ['unity-logs-warnings', 'Unity - warnings and above', 'not log.level : "info"'],
  ];
  for (const [id, title, query] of searches) {
    step(`saved search "${title}"`);
    await kb('POST', `/api/saved_objects/search/${id}?overwrite=true`, savedSearch(title, query, cols));
  }

  step('Kibana setup complete');
}

(async () => {
  try {
    if (MODE === 'elasticsearch') await setupElasticsearch();
    else if (MODE === 'kibana') await setupKibana();
    else {
      console.error('usage: node elk-setup.js <elasticsearch|kibana>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`[setup] FAILED: ${e.message}`);
    process.exit(1);
  }
})();
