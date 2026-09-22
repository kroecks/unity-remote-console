// RemoteConsoleClient.cs
// Drop this single file anywhere in your Unity project's Assets folder.
// It self-bootstraps before the first scene loads (no GameObject setup needed),
// captures all Debug logs from every thread, finds the remote console server on
// your LAN via UDP broadcast, and POSTs batches of logs to it on an interval.
//
// Configure it (optional) from your own startup code BEFORE the scene loads, e.g.
// via a [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterAssembliesLoaded)]
// method, or just tweak the defaults in Config below.
//
//   RemoteConsoleClient.Configuration.ManualHost = "192.168.1.50:8080"; // skip discovery
//   RemoteConsoleClient.Configuration.Enabled = true;
//
// By default it only runs in the Editor and Development builds.

using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.Networking;

namespace RemoteConsole
{
    public class RemoteConsoleClient : MonoBehaviour
    {
        // ------------------------------------------------------------------
        // Configuration
        // ------------------------------------------------------------------
        [Serializable]
        public class Config
        {
            /// <summary>Master switch.</summary>
            public bool Enabled = true;

            /// <summary>When true, the client does nothing in non-development player builds.</summary>
            public bool OnlyInDevelopmentBuilds = true;

            /// <summary>If set (e.g. "192.168.1.50:8080") discovery is skipped and this host is used directly.</summary>
            public string ManualHost = "";

            /// <summary>UDP port the server listens on for discovery probes.</summary>
            public int DiscoveryPort = 9999;

            /// <summary>Must match the server's MAGIC value.</summary>
            public string Magic = "UNITY_REMOTE_CONSOLE_V1";

            /// <summary>How often to flush queued logs to the server.</summary>
            public float FlushIntervalSeconds = 1.0f;

            /// <summary>Maximum log entries per HTTP batch.</summary>
            public int MaxBatchSize = 200;

            /// <summary>Hard cap on the local queue; oldest entries are dropped beyond this.</summary>
            public int MaxQueuedLogs = 5000;

            /// <summary>Include stack traces (larger payloads).</summary>
            public bool CaptureStackTraces = true;

            /// <summary>Consecutive send failures before re-running discovery.</summary>
            public int FailuresBeforeRediscover = 3;
        }

        public static Config Configuration = new Config();
        public static RemoteConsoleClient Instance { get; private set; }

        // ------------------------------------------------------------------
        // Runtime state
        // ------------------------------------------------------------------
        private readonly ConcurrentQueue<LogEntry> _queue = new ConcurrentQueue<LogEntry>();
        private int _queuedCount;

        private volatile string _serverHost;      // "ip:port" once known
        private volatile bool _discoveryRunning;
        private Thread _discoveryThread;

        private string _sessionId;
        private DeviceInfo _device;
        private int _consecutiveFailures;

        // ------------------------------------------------------------------
        // Bootstrap
        // ------------------------------------------------------------------
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Bootstrap()
        {
            if (!Configuration.Enabled) return;
            if (Configuration.OnlyInDevelopmentBuilds && !Debug.isDebugBuild && !Application.isEditor) return;
            if (Instance != null) return;

            var go = new GameObject("[RemoteConsoleClient]");
            DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideInHierarchy;
            Instance = go.AddComponent<RemoteConsoleClient>();
        }

        private void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;

            _sessionId = Guid.NewGuid().ToString("N").Substring(0, 12);
            _device = new DeviceInfo
            {
                model = SystemInfo.deviceModel,
                name = SystemInfo.deviceName,
                os = SystemInfo.operatingSystem,
                app = Application.productName + " v" + Application.version,
                unity = Application.unityVersion,
                platform = Application.platform.ToString(),
            };

            // Threaded variant captures logs raised from background threads too.
            Application.logMessageReceivedThreaded += HandleLog;

            if (!string.IsNullOrEmpty(Configuration.ManualHost))
                _serverHost = Configuration.ManualHost;
            else
                StartDiscovery();

            StartCoroutine(FlushLoop());
        }

        private void OnDestroy()
        {
            Application.logMessageReceivedThreaded -= HandleLog;
            StopDiscovery();
        }

        private void OnApplicationQuit()
        {
            StopDiscovery();
        }

        // ------------------------------------------------------------------
        // Log capture (may fire on ANY thread)
        // ------------------------------------------------------------------
        private void HandleLog(string message, string stackTrace, LogType type)
        {
            var entry = new LogEntry
            {
                t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                level = type.ToString(), // Log / Warning / Error / Assert / Exception
                message = message,
                stack = Configuration.CaptureStackTraces ? stackTrace : string.Empty,
            };

            _queue.Enqueue(entry);
            int count = Interlocked.Increment(ref _queuedCount);

            // Drop oldest if we exceed the cap (e.g. server unreachable for a while).
            while (count > Configuration.MaxQueuedLogs && _queue.TryDequeue(out _))
                count = Interlocked.Decrement(ref _queuedCount);
        }

        // ------------------------------------------------------------------
        // Flush loop (main thread; UnityWebRequest requires it)
        // ------------------------------------------------------------------
        private IEnumerator FlushLoop()
        {
            var wait = new WaitForSecondsRealtime(Configuration.FlushIntervalSeconds);
            while (true)
            {
                yield return wait;

                if (string.IsNullOrEmpty(_serverHost)) continue;
                if (_queue.IsEmpty) continue;

                var batch = new List<LogEntry>(Configuration.MaxBatchSize);
                while (batch.Count < Configuration.MaxBatchSize && _queue.TryDequeue(out var e))
                {
                    Interlocked.Decrement(ref _queuedCount);
                    batch.Add(e);
                }
                if (batch.Count == 0) continue;

                yield return StartCoroutine(SendBatch(batch));
            }
        }

        private IEnumerator SendBatch(List<LogEntry> batch)
        {
            var payload = new Batch
            {
                session = _sessionId,
                device = _device,
                logs = batch.ToArray(),
            };

            string json = JsonUtility.ToJson(payload);
            byte[] body = Encoding.UTF8.GetBytes(json);
            string url = "http://" + _serverHost + "/ingest";

            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(body);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 5;

                yield return req.SendWebRequest();

#if UNITY_2020_1_OR_NEWER
                bool ok = req.result == UnityWebRequest.Result.Success;
#else
                bool ok = !req.isNetworkError && !req.isHttpError;
#endif
                if (ok)
                {
                    _consecutiveFailures = 0;
                }
                else
                {
                    _consecutiveFailures++;
                    // NOTE: never call Debug.Log* here — it would feed back into HandleLog.
                    if (string.IsNullOrEmpty(Configuration.ManualHost) &&
                        _consecutiveFailures >= Configuration.FailuresBeforeRediscover)
                    {
                        _consecutiveFailures = 0;
                        _serverHost = null;
                        StartDiscovery();
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Discovery (background thread)
        // ------------------------------------------------------------------
        private void StartDiscovery()
        {
            if (_discoveryRunning) return;
            _discoveryRunning = true;
            _discoveryThread = new Thread(DiscoveryWorker)
            {
                IsBackground = true,
                Name = "RemoteConsoleDiscovery",
            };
            _discoveryThread.Start();
        }

        private void StopDiscovery()
        {
            _discoveryRunning = false;
            try { _discoveryThread?.Join(500); } catch { /* ignore */ }
            _discoveryThread = null;
        }

        private void DiscoveryWorker()
        {
            byte[] probe = Encoding.UTF8.GetBytes(Configuration.Magic + ":DISCOVER");

            while (_discoveryRunning && string.IsNullOrEmpty(_serverHost))
            {
                try
                {
                    using (var udp = new UdpClient())
                    {
                        udp.EnableBroadcast = true;
                        udp.Client.ReceiveTimeout = 1500;

                        var target = new IPEndPoint(IPAddress.Broadcast, Configuration.DiscoveryPort);
                        udp.Send(probe, probe.Length, target);

                        var from = new IPEndPoint(IPAddress.Any, 0);
                        byte[] resp = udp.Receive(ref from); // blocks up to ReceiveTimeout
                        string text = Encoding.UTF8.GetString(resp);

                        var reply = JsonUtility.FromJson<DiscoveryReply>(text);
                        if (reply != null && reply.service == "unity-remote-console" && reply.http > 0)
                        {
                            _serverHost = from.Address.ToString() + ":" + reply.http;
                            break;
                        }
                    }
                }
                catch (SocketException)
                {
                    // No reply in time — wait a moment and probe again.
                    Thread.Sleep(1000);
                }
                catch (Exception)
                {
                    Thread.Sleep(1000);
                }
            }

            _discoveryRunning = false;
        }

        // ------------------------------------------------------------------
        // Serializable payloads (JsonUtility-friendly)
        // ------------------------------------------------------------------
        [Serializable]
        private class LogEntry
        {
            public long t;
            public string level;
            public string message;
            public string stack;
        }

        [Serializable]
        private class DeviceInfo
        {
            public string model;
            public string name;
            public string os;
            public string app;
            public string unity;
            public string platform;
        }

        [Serializable]
        private class Batch
        {
            public string session;
            public DeviceInfo device;
            public LogEntry[] logs;
        }

        [Serializable]
        private class DiscoveryReply
        {
            public string service;
            public string magic;
            public int http;
            public string name;
        }
    }
}
