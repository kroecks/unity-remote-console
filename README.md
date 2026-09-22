# Unity Remote Console

Self-hosted, LAN-only remote logging for Unity apps. Run the server in Docker on
any machine on your network, drop one C# file into your Unity project, and watch
`Debug.Log` output stream into a browser in semi-realtime — no adb required.

```
device (Unity)                     host on your LAN (Docker)              you
─────────────                      ─────────────────────────            ─────
RemoteConsoleClient.cs             server.js
  ├─ UDP broadcast  ───────────▶   UDP :9999  discovery responder
  │   ◀─────────────────────────   reply { http: 8080 }
  ├─ batches logs every 1s
  └─ HTTP POST /ingest ────────▶   HTTP :8080  ─── WebSocket push ──▶  browser UI
```

## 1. Run the server

**Docker (recommended, on a Linux host on your LAN):**

```bash
cd server
docker compose up --build
```

Then open `http://<host-lan-ip>:8080` in a browser. The server prints the exact
URL(s) on startup.

> **Why host networking?** UDP discovery relies on LAN broadcast, which a bridged
> Docker container cannot receive. `docker-compose.yml` uses `network_mode: host`
> for this reason. On Docker Desktop (Mac/Windows) host networking is limited —
> see the fallback below.

**Without Docker:**

```bash
cd server
npm install
npm start
```

**Fallback (bridged, no discovery):**

```bash
cd server
docker compose -f docker-compose.bridge.yml up --build
```

The web UI and log ingest work, but you must set a **Manual Host** in the Unity
client (auto-discovery won't reach a bridged container).

## 2. Add the client to Unity

Copy `unity/RemoteConsoleClient.cs` anywhere under your project's `Assets/`
folder. That's it — it self-bootstraps before the first scene loads and needs no
GameObject or inspector setup.

By default it only runs in the **Editor** and **Development builds**
(`OnlyInDevelopmentBuilds = true`). Make sure "Development Build" is checked in
your build settings, or set that flag to `false`.

### Optional configuration

Set values before the scene loads (defaults are usually fine):

```csharp
using RemoteConsole;
using UnityEngine;

static class RemoteConsoleSetup
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterAssembliesLoaded)]
    static void Configure()
    {
        // Skip discovery and point straight at the host (needed for bridged Docker):
        RemoteConsoleClient.Configuration.ManualHost = "192.168.1.50:8080";

        // Other knobs:
        RemoteConsoleClient.Configuration.FlushIntervalSeconds = 1.0f;
        RemoteConsoleClient.Configuration.MaxBatchSize = 200;
        RemoteConsoleClient.Configuration.CaptureStackTraces = true;
    }
}
```

## 3. Platform gotchas (important)

The client POSTs over plain **HTTP** on your LAN. Modern mobile OSes block
cleartext HTTP by default, so for development builds you need to allow it:

- **Android (9+):** enable cleartext traffic. Simplest route: Player Settings →
  Publishing Settings → use a custom `AndroidManifest.xml` with
  `android:usesCleartextTraffic="true"` on the `<application>` tag, or add a
  network security config permitting your host's IP.
- **iOS:** App Transport Security blocks arbitrary HTTP. For dev builds add an
  ATS exception (e.g. `NSAllowsArbitraryLoads` = YES) via a custom `Info.plist`
  entry. Use dev builds only — don't ship this.
- **Android receiving discovery:** replies are unicast back to the device, so a
  multicast lock is not required. If discovery is flaky on your network, set a
  `ManualHost` instead.

## Configuration reference

### Server (environment variables)

| Var              | Default                     | Purpose                              |
| ---------------- | --------------------------- | ------------------------------------ |
| `PORT`           | `8080`                      | HTTP + WebSocket port                |
| `DISCOVERY_PORT` | `9999`                      | UDP discovery port                   |
| `MAGIC`          | `UNITY_REMOTE_CONSOLE_V1`   | Must match the client's `Magic`      |
| `BUFFER_SIZE`    | `5000`                      | Logs kept in memory / sent on connect|
| `OFFLINE_AFTER_MS`| `10000`                    | Mark a device offline after silence  |

### Client (`RemoteConsoleClient.Configuration`)

| Field                     | Default | Purpose                                      |
| ------------------------- | ------- | -------------------------------------------- |
| `Enabled`                 | `true`  | Master switch                                |
| `OnlyInDevelopmentBuilds` | `true`  | Disable in release player builds             |
| `ManualHost`              | `""`    | `ip:port`; skips discovery when set          |
| `DiscoveryPort`           | `9999`  | Must match the server                        |
| `Magic`                   | `…_V1`  | Must match the server                        |
| `FlushIntervalSeconds`    | `1.0`   | How often batches are sent                   |
| `MaxBatchSize`            | `200`   | Max entries per HTTP batch                   |
| `MaxQueuedLogs`           | `5000`  | Local cap; oldest dropped if server is down  |
| `CaptureStackTraces`      | `true`  | Include stack traces in payloads             |

## UI features

- Live stream over WebSocket; new browsers get the recent buffer on connect.
- Per-device sidebar with online/offline dots and log counts; click to filter.
- Level toggles (Log / Warning / Error / Assert / Exception), text search.
- Follow-tail (auto-pauses when you scroll up), pause-and-buffer, line wrap, clear.
- Click any row with a stack trace to expand it.

## Notes & limitations

- State is in-memory only; restarting the server clears history. (Swap the ring
  buffer for a file/DB write in `pushLog` if you want persistence.)
- No auth or TLS — this is designed for a trusted LAN. Don't expose it publicly.
- Multiple devices and multiple browser viewers are supported simultaneously.
