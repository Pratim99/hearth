using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Hearth
{
    /// <summary>
    /// Loopback-only HTTP server that hosts the UI and its API. It binds to 127.0.0.1, requires a
    /// per-launch session cookie, and rejects cross-origin writes, so other programs and web pages
    /// cannot drive it.
    /// </summary>
    class Server
    {
        readonly string _appDir;
        readonly string _token;
        HttpListener _listener;
        int _port;
        int _lifelines;
        bool _everConnected;
        DateTime _lastSeen = DateTime.UtcNow;
        volatile bool _stopping;

        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
            { ".js", "text/javascript; charset=utf-8" }, { ".svg", "image/svg+xml" },
            { ".ico", "image/x-icon" }, { ".png", "image/png" }, { ".json", "application/json" },
            { ".woff2", "font/woff2" }
        };

        public Server(string appDir)
        {
            _appDir = Path.GetFullPath(appDir);
            byte[] b = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            _token = BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }

        public string Origin { get { return "http://127.0.0.1:" + _port; } }
        public string LaunchUrl { get { return Origin + "/?t=" + _token; } }

        public void Start(int preferredPort)
        {
            Exception last = null;
            for (int p = preferredPort; p < preferredPort + 25; p++)
            {
                try
                {
                    var l = new HttpListener();
                    l.Prefixes.Add("http://127.0.0.1:" + p + "/");
                    l.Start();
                    _listener = l;
                    _port = p;
                    break;
                }
                catch (Exception ex) { last = ex; }
            }
            if (_listener == null) throw new Exception("Could not open a local port for the interface. " + (last != null ? last.Message : ""));

            var t = new Thread(AcceptLoop) { IsBackground = true, Name = "accept" };
            t.Start();
        }

        public void Stop()
        {
            _stopping = true;
            try { _listener.Stop(); } catch { }
        }

        /// <summary>Blocks until every window has been closed for a few seconds.</summary>
        public void WaitUntilIdle(bool stayForever)
        {
            DateTime started = DateTime.UtcNow;
            while (!_stopping)
            {
                Thread.Sleep(500);
                if (stayForever) continue;
                if (Volatile.Read(ref _lifelines) > 0) { _lastSeen = DateTime.UtcNow; continue; }
                if (_everConnected && (DateTime.UtcNow - _lastSeen).TotalSeconds > 6) return;
                if (!_everConnected && (DateTime.UtcNow - started).TotalSeconds > 90) return;
            }
        }

        void AcceptLoop()
        {
            while (!_stopping)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch { if (_stopping) return; continue; }
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }

        // ---------------------------------------------------------------- request handling

        void Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            try
            {
                res.Headers["X-Content-Type-Options"] = "nosniff";
                res.Headers["Cache-Control"] = "no-store";
                res.Headers["Referrer-Policy"] = "no-referrer";

                string path = req.Url.AbsolutePath;
                var query = ParseQuery(req.Url.Query);

                if (path == "/api/ping") { SendJson(res, J.Make("ok", true)); return; }

                // First navigation carries the launch token; swap it for a cookie and drop it from the URL.
                if (path == "/" && query.ContainsKey("t"))
                {
                    if (!SafeEquals(query["t"], _token)) { SendText(res, 403, "This Hearth link has expired. Start Hearth again."); return; }
                    res.Headers["Set-Cookie"] = "hearth=" + _token + "; Path=/; HttpOnly; SameSite=Strict";
                    res.StatusCode = 302;
                    res.Headers["Location"] = "/";
                    res.Close();
                    return;
                }

                var cookie = req.Cookies["hearth"];
                if (cookie == null || !SafeEquals(cookie.Value, _token))
                {
                    SendText(res, 403, "Hearth is running, but this window is not signed in to it. Close this and start Hearth from its icon.");
                    return;
                }

                if (req.HttpMethod != "GET")
                {
                    string origin = req.Headers["Origin"];
                    if (!string.IsNullOrEmpty(origin) && !string.Equals(origin, Origin, StringComparison.OrdinalIgnoreCase))
                    {
                        SendJson(res, J.Make("error", "Cross-origin request refused."), 403);
                        return;
                    }
                }

                if (path.StartsWith("/api/")) Api(ctx, path, query);
                else Static(res, path);
            }
            catch (ApiException ex) { TrySendError(res, ex.Status, ex.Message); }
            catch (HttpListenerException) { /* the window went away mid-response */ }
            catch (Exception ex) { TrySendError(res, 500, ex.Message); }
            finally { try { res.Close(); } catch { } }
        }

        void Api(HttpListenerContext ctx, string path, Dictionary<string, string> q)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            bool post = req.HttpMethod == "POST";

            switch (path)
            {
                // ---- app state
                case "/api/state":
                    SendJson(res, J.Make(
                        "ollama", OllamaStatus(),
                        "projects", Store.Projects(),
                        "settings", Store.Settings(),
                        "hardware", Hardware.Info(),
                        "sourceLevel", Sources.Level(),
                        "version", "1.0"));
                    return;
                case "/api/lifeline":
                    Lifeline(res);
                    return;
                case "/api/settings":
                    RequirePost(post);
                    var patch = Body(req);
                    if (patch.ContainsKey("sourceLevel")) patch["sourceLevel"] = Sources.NormalizeLevel(patch["sourceLevel"]);
                    SendJson(res, Store.UpdateSettings(patch));
                    return;

                // ---- ollama
                case "/api/ollama/status":
                    SendJson(res, OllamaStatus());
                    return;
                case "/api/ollama/start":
                    RequirePost(post);
                    SendJson(res, J.Make("started", OllamaProcess.Start()));
                    return;
                case "/api/models":
                    SendJson(res, Models());
                    return;
                case "/api/models/delete":
                {
                    RequirePost(post);
                    string name = J.S(Body(req), "name");
                    int status;
                    string text = Ollama.Call("DELETE", "/api/delete", J.Str(J.Make("model", name)), 30000, out status);
                    Ollama.InvalidateTags();
                    if (status >= 400) throw new ApiException(502, Ollama.ErrorText(text, "Could not remove the model."));
                    SendJson(res, J.Make("ok", true));
                    return;
                }
                case "/api/models/unload":
                {
                    RequirePost(post);
                    string name = J.S(Body(req), "name");
                    int status;
                    Ollama.Call("POST", "/api/generate", J.Str(J.Make("model", name, "keep_alive", 0)), 30000, out status);
                    SendJson(res, J.Make("ok", status < 400));
                    return;
                }
                case "/api/models/pull":
                {
                    RequirePost(post);
                    string name = J.S(Body(req), "name", "").Trim();
                    Sources.RequireDownloadAllowed(name);     // <- local-only + source security level + Hugging Face scan
                    Relay(res, "/api/pull", J.Str(J.Make("model", name, "stream", true)));
                    Ollama.InvalidateTags();
                    return;
                }
                case "/api/chat":
                {
                    RequirePost(post);
                    var body = Body(req);
                    string model = J.S(body, "model");
                    Ollama.RequireLocalModel(model);          // <- the local-hardware gate for all inference
                    var payload = J.Make("model", model, "messages", J.Get(body, "messages"), "stream", true);
                    if (body.ContainsKey("options")) payload["options"] = body["options"];
                    if (body.ContainsKey("think")) payload["think"] = body["think"];
                    // Tool definitions only describe what the model may ask for. Nothing runs here: the window
                    // shows each requested change for approval, then calls the guarded /api/fs endpoints.
                    if (body.ContainsKey("tools")) payload["tools"] = body["tools"];
                    Relay(res, "/api/chat", J.Str(payload));
                    return;
                }

                // ---- online catalog (metadata only)
                case "/api/catalog/search":
                    SendJson(res, Catalog.SearchOllama(Q(q, "q"), Q(q, "caps"), Q(q, "size"), Q(q, "sort"), Q(q, "page")));
                    return;
                case "/api/catalog/tags":
                    SendJson(res, Catalog.OllamaTags(Q(q, "name")));
                    return;
                case "/api/catalog/hf":
                    SendJson(res, Catalog.SearchHuggingFace(Q(q, "q"), Q(q, "sort")));
                    return;
                case "/api/catalog/hf-files":
                    SendJson(res, Catalog.HuggingFaceFiles(Q(q, "id")));
                    return;

                // ---- projects
                case "/api/projects/add":
                {
                    RequirePost(post);
                    var b = Body(req);
                    SendJson(res, Store.AddProject(J.S(b, "name"), J.S(b, "path", "")));
                    return;
                }
                case "/api/projects/update":
                {
                    RequirePost(post);
                    var b = Body(req);
                    SendJson(res, Store.UpdateProject(J.S(b, "id"), b));
                    return;
                }
                case "/api/projects/remove":
                    RequirePost(post);
                    Store.RemoveProject(J.S(Body(req), "id"));
                    SendJson(res, J.Make("ok", true));
                    return;
                case "/api/pick-folder":
                    RequirePost(post);
                    SendJson(res, J.Make("path", FolderPicker.Pick("Choose a folder for this project")));
                    return;

                // ---- files
                case "/api/fs/list":
                    SendJson(res, Files.List(Q(q, "project"), Q(q, "path")));
                    return;
                case "/api/fs/find":
                    SendJson(res, Files.Find(Q(q, "project"), Q(q, "q")));
                    return;
                case "/api/fs/read":
                    SendJson(res, Files.Read(Q(q, "project"), Q(q, "path")));
                    return;
                case "/api/fs/write":
                {
                    RequirePost(post);
                    var b = Body(req);
                    object bom = J.Get(b, "bom");
                    SendJson(res, Files.Write(J.S(b, "project"), J.S(b, "path"), J.S(b, "content", ""), J.S(b, "eol", "lf"),
                        bom is bool && (bool)bom, J.S(b, "modified", "")));
                    return;
                }

                case "/api/fs/create":
                {
                    RequirePost(post);
                    var b = Body(req);
                    object folder = J.Get(b, "folder");
                    SendJson(res, Files.Create(J.S(b, "project"), J.S(b, "parent", ""), J.S(b, "name"), folder is bool && (bool)folder, J.S(b, "content", "")));
                    return;
                }
                case "/api/fs/move":
                {
                    RequirePost(post);
                    var b = Body(req);
                    SendJson(res, Files.Move(J.S(b, "project"), J.S(b, "from"), b.ContainsKey("toParent") ? J.S(b, "toParent", "") : null, J.S(b, "name")));
                    return;
                }
                case "/api/fs/delete":
                {
                    RequirePost(post);
                    var b = Body(req);
                    SendJson(res, Files.Delete(J.S(b, "project"), J.S(b, "path")));
                    return;
                }
                case "/api/fs/protect":
                {
                    RequirePost(post);
                    var b = Body(req);
                    object on = J.Get(b, "on");
                    SendJson(res, Files.SetProtected(J.S(b, "project"), J.S(b, "path"), on is bool && (bool)on));
                    return;
                }

                // ---- GitHub (sign-in and uploads are carried out by the GitHub CLI and Git; only when the user asks)
                case "/api/github/status":
                    SendJson(res, GitHub.Status());
                    return;
                case "/api/github/signin":
                    RequirePost(post);
                    GitHub.SignIn(res);
                    return;
                case "/api/github/signout":
                    RequirePost(post);
                    SendJson(res, GitHub.SignOut());
                    return;
                case "/api/github/project":
                    SendJson(res, GitHub.ProjectStatus(Q(q, "project")));
                    return;
                case "/api/github/upload":
                    RequirePost(post);
                    GitHub.Upload(res, Body(req));
                    return;
                case "/api/open-url":
                    RequirePost(post);
                    GitHub.OpenInBrowser(J.S(Body(req), "url", ""));
                    SendJson(res, J.Make("ok", true));
                    return;

                // ---- chats
                case "/api/chats":
                    SendJson(res, J.Make("chats", Store.ListChats(Q(q, "project"))));
                    return;
                case "/api/chats/get":
                    SendRaw(res, 200, "application/json; charset=utf-8", Store.ReadChat(Q(q, "project"), Q(q, "id")));
                    return;
                case "/api/chats/save":
                    RequirePost(post);
                    Store.SaveChat(Q(q, "project"), ReadBody(req));
                    SendJson(res, J.Make("ok", true));
                    return;
                case "/api/chats/delete":
                {
                    RequirePost(post);
                    var b = Body(req);
                    Store.DeleteChat(J.S(b, "project"), J.S(b, "id"));
                    SendJson(res, J.Make("ok", true));
                    return;
                }
            }
            throw new ApiException(404, "Unknown endpoint.");
        }

        // ---------------------------------------------------------------- ollama views

        static object OllamaStatus()
        {
            var d = J.Make("endpoint", Ollama.Base, "running", false, "version", "", "warning", Ollama.EndpointWarning);
            try
            {
                d["version"] = J.S(Ollama.GetJson("/api/version", 2500), "version", "");
                d["running"] = true;
            }
            catch { }
            return d;
        }

        static object Models()
        {
            var local = new List<object>();
            var blocked = new List<object>();
            foreach (var t in Ollama.Tags(true))
            {
                string name = J.S(t, "name", "");
                string reason = Ollama.RemoteReason(t);
                if (reason != null) { blocked.Add(J.Make("name", name, "reason", reason)); continue; }
                var det = J.Obj(J.Get(t, "details")) ?? new Dictionary<string, object>();
                local.Add(J.Make(
                    "name", name,
                    "source", Sources.InstalledSource(name),
                    "size", J.L(t, "size"),
                    "modified", J.S(t, "modified_at", ""),
                    "family", J.S(det, "family", ""),
                    "params", J.S(det, "parameter_size", ""),
                    "quant", J.S(det, "quantization_level", ""),
                    "context", J.L(det, "context_length"),
                    "capabilities", J.Arr(J.Get(t, "capabilities")).ToList()));
            }

            var running = new List<object>();
            try
            {
                foreach (object o in J.Arr(J.Get(Ollama.GetJson("/api/ps", 4000), "models")))
                {
                    var p = J.Obj(o);
                    if (p == null) continue;
                    running.Add(J.Make(
                        "name", J.S(p, "name", ""),
                        "size", J.L(p, "size"),
                        "vram", J.L(p, "size_vram"),
                        "context", J.L(p, "context_length"),
                        "expires", J.S(p, "expires_at", "")));
                }
            }
            catch { }
            return J.Make("models", local, "blocked", blocked, "running", running);
        }

        /// <summary>Streams an Ollama response (newline-delimited JSON) straight through to the window.</summary>
        static void Relay(HttpListenerResponse res, string path, string json)
        {
            var up = Ollama.Create("POST", path, Timeout.Infinite);
            byte[] b = Encoding.UTF8.GetBytes(json);
            up.ContentType = "application/json";
            up.ContentLength = b.Length;
            HttpWebResponse upRes;
            try
            {
                using (var s = up.GetRequestStream()) s.Write(b, 0, b.Length);
                upRes = (HttpWebResponse)up.GetResponse();
            }
            catch (WebException ex)
            {
                upRes = ex.Response as HttpWebResponse;
                if (upRes == null) throw new ApiException(503, "Ollama is not reachable on this PC (" + Ollama.Base + ").");
            }

            using (upRes)
            using (var src = upRes.GetResponseStream())
            {
                if ((int)upRes.StatusCode >= 400)
                {
                    string text = new StreamReader(src, Encoding.UTF8).ReadToEnd();
                    throw new ApiException((int)upRes.StatusCode == 404 ? 404 : 502, Ollama.ErrorText(text, "Ollama returned an error."));
                }
                res.StatusCode = 200;
                res.ContentType = "application/x-ndjson; charset=utf-8";
                res.SendChunked = true;
                var buf = new byte[16384];
                try
                {
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        res.OutputStream.Write(buf, 0, n);
                        res.OutputStream.Flush();
                    }
                }
                catch
                {
                    // The window stopped listening (Stop button or closed): cancel the work in Ollama too.
                    try { up.Abort(); } catch { }
                }
            }
        }

        void Lifeline(HttpListenerResponse res)
        {
            Interlocked.Increment(ref _lifelines);
            _everConnected = true;
            try
            {
                res.StatusCode = 200;
                res.ContentType = "text/plain";
                res.SendChunked = true;
                byte[] beat = Encoding.ASCII.GetBytes(".\n");
                while (!_stopping)
                {
                    res.OutputStream.Write(beat, 0, beat.Length);
                    res.OutputStream.Flush();
                    Thread.Sleep(1500);
                }
            }
            catch { }
            finally
            {
                _lastSeen = DateTime.UtcNow;
                Interlocked.Decrement(ref _lifelines);
            }
        }

        // ---------------------------------------------------------------- static files

        void Static(HttpListenerResponse res, string path)
        {
            if (path == "/" || path == "") path = "/index.html";
            string full = Path.GetFullPath(Path.Combine(_appDir, Uri.UnescapeDataString(path).TrimStart('/').Replace('/', '\\')));
            if (!full.StartsWith(_appDir + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                SendText(res, 404, "Not found");
                return;
            }
            string type;
            if (!Mime.TryGetValue(Path.GetExtension(full), out type)) type = "application/octet-stream";
            if (type.StartsWith("text/html"))
            {
                // The interface can only talk to this local server: no CDNs, no remote scripts, no outside calls.
                res.Headers["Content-Security-Policy"] =
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
                    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
            }
            byte[] bytes = File.ReadAllBytes(full);
            res.StatusCode = 200;
            res.ContentType = type;
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
        }

        // ---------------------------------------------------------------- helpers

        static void RequirePost(bool post)
        {
            if (!post) throw new ApiException(405, "Use POST for this endpoint.");
        }

        static string Q(Dictionary<string, string> q, string key)
        {
            string v;
            return q.TryGetValue(key, out v) ? v : "";
        }

        static Dictionary<string, string> ParseQuery(string query)
        {
            var d = new Dictionary<string, string>();
            if (string.IsNullOrEmpty(query)) return d;
            foreach (string part in query.TrimStart('?').Split('&'))
            {
                if (part == "") continue;
                int eq = part.IndexOf('=');
                string k = eq < 0 ? part : part.Substring(0, eq);
                string v = eq < 0 ? "" : part.Substring(eq + 1);
                try { d[Uri.UnescapeDataString(k.Replace('+', ' '))] = Uri.UnescapeDataString(v.Replace('+', ' ')); } catch { }
            }
            return d;
        }

        static string ReadBody(HttpListenerRequest req)
        {
            using (var r = new StreamReader(req.InputStream, Encoding.UTF8)) return r.ReadToEnd();
        }

        static Dictionary<string, object> Body(HttpListenerRequest req)
        {
            try { return J.ParseObj(ReadBody(req)); }
            catch (ApiException) { throw; }
            catch { throw new ApiException(400, "Malformed request."); }
        }

        static bool SafeEquals(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }

        static void SendRaw(HttpListenerResponse res, int status, string type, string text)
        {
            byte[] b = Encoding.UTF8.GetBytes(text);
            res.StatusCode = status;
            res.ContentType = type;
            res.ContentLength64 = b.Length;
            res.OutputStream.Write(b, 0, b.Length);
        }

        static void SendJson(HttpListenerResponse res, object o, int status = 200)
        {
            SendRaw(res, status, "application/json; charset=utf-8", J.Str(o));
        }

        static void SendText(HttpListenerResponse res, int status, string text)
        {
            SendRaw(res, status, "text/plain; charset=utf-8", text);
        }

        static void TrySendError(HttpListenerResponse res, int status, string message)
        {
            try { SendJson(res, J.Make("error", message), status); } catch { }
        }
    }
}
