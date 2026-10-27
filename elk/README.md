# ELK setup: Unity logs + host metrics

```
 Unity client machine                 ELK VM (Proxmox, Docker/Portainer)              you
 ────────────────────                 ──────────────────────────────────            ─────
 RemoteConsoleClient.cs  ── UDP 9999 ─▶ remote-console ──┐
   (unchanged)           ── POST /ingest ▶  :8080 live UI ─┼─ _bulk ─▶ Elasticsearch :9200
 Metricbeat ───────────────────────────────────────────────┤               │
                                                           │           Kibana :5601 ◀── browser
 N other hosts                                             │
 Metricbeat + Filebeat (agent stack) ──────────────────────┘
```

| Stack | Where | What it runs |
|---|---|---|
| `elk/host` | the ELK VM | Elasticsearch, Kibana, one-shot setup jobs, the remote console (discovery + `/ingest` + live UI, now forwarding to Elasticsearch) |
| `elk/agent` | every Linux host (incl. the Unity machine if it's Linux) | Metricbeat (CPU, memory, disk, network, processes, per-container stats, optional GPU) + Filebeat (container stdout/stderr, syslog, auth.log) |
| `elk/windows` | the Unity machine, if it's Windows | Metricbeat as a Windows service |

The Unity C# client needs **no changes**. It still discovers the console over UDP and posts to `/ingest`. The console keeps its live web UI and also bulk-indexes every log into the `logs-unity.console-default` data stream.

---

## 1. Prepare the VM

- **Size:** 4 vCPU, 8 GB RAM minimum (16 GB is comfortable), and SSD storage sized for your retention.
- **Network:** attach the VM to the same bridge/VLAN as the Unity devices (e.g. `vmbr0`). UDP broadcast discovery doesn't cross subnets. If it can't be on the same subnet, use `ManualHost` (step 3).
- **Install** Docker and add the VM to Portainer (Portainer Agent or a local Portainer).
- **Kernel setting** (Elasticsearch won't start without it):
  ```bash
  echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-elasticsearch.conf
  sudo sysctl --system
  ```

## 2. Deploy the host stack

The console image is built straight from git, so **push this branch first**. `CONSOLE_BUILD_CONTEXT` defaults to `https://github.com/kroecks/unity-remote-console.git#master:server`; point it at another branch with `#branch:server`.

Then in Portainer on the VM, go to **Stacks → Add stack → Web editor**:
1. Paste `elk/host/docker-compose.yml`.
2. Under **Environment variables → Advanced mode**, paste `elk/host/.env.example` and change every password. Generate the encryption key with `openssl rand -hex 16`.
3. **Deploy.** The first start takes 2–4 minutes and runs in this order:

```
es01 (healthy) → es-setup → kibana (healthy) → kibana-setup, metricbeat-setup, filebeat-setup
                         └→ remote-console
```

The `*-setup` containers exit with code 0 when they finish; that's expected. They're idempotent and re-run on every redeploy. That's also how you apply a changed `LOG_RETENTION`.

**Check it:**
- `http://<vm>:5601`: log in as `elastic` / `ELASTIC_PASSWORD`.
- `http://<vm>:8080/healthz`: should show `"elastic":{"enabled":true,...,"indexed":N}`.
- `http://<vm>:8080`: the live console, same as before.

`es-setup` creates:
- **`shipper` user:** write-only (can append to `metricbeat-*`, `filebeat-*`, `logs-unity.*`, nothing else). It's the only credential that goes onto other machines.
- **Retention:** Unity and Filebeat logs keep `LOG_RETENTION` (30 days), Metricbeat keeps `METRICS_RETENTION` (14 days).
- **Index template** for `logs-unity.*` with explicit field mappings (see the field reference below).

## 3. The Unity client machine

**Logs:** nothing to do if it's on the same subnet, because discovery finds the VM. Otherwise:

```csharp
RemoteConsoleClient.Configuration.ManualHost = "192.168.1.60:8080"; // the ELK VM
```

**Metrics:**
- **Linux:** deploy the agent stack (step 4) with `AGENT_ROLE=unity-client`.
- **Windows:** follow the header of `elk/windows/metricbeat.yml` (unzip, drop in the config, install the service).

The Unity logs carry `host.name` = `SystemInfo.deviceName` lowercased, which on desktop is the machine's hostname, the same value Metricbeat reports. So `host.name : "gaming-pc"` filters both logs and that machine's CPU and memory. The original casing is kept in `host.hostname`.

## 4. Every other host: the agent stack

In Portainer on each host, go to **Stacks → Add stack → Web editor**:
1. Paste `elk/agent/docker-compose.yml`.
2. Set the env vars from `elk/agent/.env.example`: `ES_URL=http://<vm>:9200`, `SHIPPER_PASSWORD`, and an `AGENT_ROLE` tag of your choice.
3. **Deploy.**

The configs are inline, so no files are needed on the host. You can also run the agent stack on the ELK VM itself to monitor the monitor.

**GPU hosts:** install `nvidia-container-toolkit`, uncomment the `dcgm-exporter` service, pin an image tag from NGC, and set `GPU_METRICS=true`. GPU series then arrive as `prometheus.metrics.DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_GPU_TEMP`, `DCGM_FI_DEV_POWER_USAGE`, etc.

---

## Using it

### Log search (Discover)

`kibana-setup` creates a **Unity logs** data view (set as the default) and three saved searches under Discover → Open: *all logs*, *errors & exceptions*, *warnings and above*.

Useful KQL:
```
log.level : ("error" or "exception")
message : "NullReferenceException"
unity.session : "a1b2c3d4e5f6"                 # one play session
host.name : "gaming-pc" and not log.level : "info"
error.stack_trace : *PlayerController*
service.version : "0.4.1"
```

ES|QL (Discover → "Try ES|QL") for quick aggregations:
```esql
FROM logs-unity.*
| WHERE log.level IN ("error", "exception")
| STATS errors = COUNT(*) BY message.keyword
| SORT errors DESC | LIMIT 20
```
```esql
FROM logs-unity.*
| STATS logs = COUNT(*) BY bucket = BUCKET(@timestamp, 1 minute), log.level
```

### Host metrics: your "what did the server do during the session" view

Dashboards → **[Metricbeat System] Host overview ECS** (pick the host at the top) and **[Metricbeat Docker] Overview ECS** for per-container usage. Set the time picker to your session window. Container logs from the agents are in Discover under the `filebeat-*` data view.

### A Unity dashboard in ~5 minutes

Dashboards → Create → **Create visualization** (Lens), data view *Unity logs*:
1. **Logs over time by level:** bar chart, X = `@timestamp`, break down by `log.level`.
2. **Top errors:** table, rows = `message.keyword` (top 20), filter `log.level : ("error" or "exception")`.
3. **Logs by device:** table, rows = `host.name`, metric = count, plus unique count of `unity.session`.
4. **Add from library →** the *Unity - errors & exceptions* saved search, as a live log table.
5. Optionally, **Add from library →** Metricbeat's CPU and memory panels, so game logs and host load share one time axis.

### Unity log field reference

| Field | From | Example |
|---|---|---|
| `@timestamp` | log `t` | client-side time |
| `message` (+ `.keyword`) | `message` | `Player joined` |
| `log.level` | `level`, normalized | `info` `warning` `error` `assert` `exception` |
| `unity.log_type` | `level`, raw | `Log` `Exception` |
| `error.stack_trace` | `stack` | |
| `unity.session` | `session` | `a1b2c3d4e5f6` |
| `host.name` / `host.hostname` | `device.name` (lowercased / as-is) | `gaming-pc` / `GAMING-PC` |
| `device.model.name` | `device.model` | |
| `os.full` | `device.os` | |
| `service.name` / `service.version` | `device.app` split on ` v` | `MyGame` / `0.4.1` |
| `unity.version`, `unity.platform` | `device.unity`, `device.platform` | `6000.0.32f1`, `WindowsPlayer` |
| `source.ip` | sender IP | |
| `event.sequence` | console's counter | stable order within the same millisecond |

---

## Operations

- **Restart behaviour:** the console holds up to `ES_MAX_QUEUE` logs (100k) in memory while Elasticsearch is down and retries with backoff. On a clean stop it flushes for up to 5 seconds. Agents keep their own disk registry and resume where they left off.
- **Retention:** change `LOG_RETENTION` / `METRICS_RETENTION` and redeploy the host stack.
- **Environments:** set `UNITY_NAMESPACE=qa` to send to `logs-unity.console-qa`. The data view `logs-unity.*` still covers all of them.
- **Upgrading:** bump `STACK_VERSION` on all stacks together, host stack first.
- **Disk:** watch Stack Management → Index Management. `GET _cat/indices?v&s=store.size:desc` in Dev Tools shows what's big.

### Troubleshooting

| Symptom | Check |
|---|---|
| `es01` restarts immediately | `vm.max_map_count` not set; or the VM has too little RAM for `ES_HEAP` |
| `es-setup` failed | `docker logs <stack>-es-setup-1`; usually a password mismatch with an existing `esdata` volume (the `elastic` password is only applied on first boot) |
| Unity logs in live UI but not Kibana | `/healthz` → `elastic.lastError`; a 401 or 403 means `SHIPPER_PASSWORD` differs from the host stack's |
| Device never finds the console | different subnet / VLAN, or Proxmox firewall blocking UDP 9999; use `ManualHost` |
| Agent shows nothing | `docker logs metricbeat`; `curl -u shipper:<pw> http://<vm>:9200` from the host |
| Metricbeat dashboards empty | `metricbeat-setup` must have exited 0 on the host stack; time picker range |

### Security notes

This is built for a trusted LAN: plain HTTP, password auth on. Don't expose 9200 or 5601 to the internet. To add TLS later, put Kibana behind your reverse proxy, and for Elasticsearch enable `xpack.security.http.ssl` with a cert, then switch `ES_URL`s to `https://` and add `ssl.certificate_authorities` in the Beats configs.
