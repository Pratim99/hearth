using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>
    /// THE LOCAL-ONLY GUARANTEE LIVES HERE.
    ///
    /// Every AI feature in Hearth goes through this class, and this class enforces two rules:
    ///   1. The inference endpoint is always a loopback address on this PC. A non-local
    ///      OLLAMA_HOST is ignored, and no system proxy is ever used for the connection.
    ///   2. Models that Ollama would relay to a remote host ("cloud" models) are refused,
    ///      both for chatting and for downloading.
    /// </summary>
    static class Ollama
    {
        public static readonly string Base;
        public static readonly string EndpointWarning;

        static readonly Regex CloudName = new Regex(@"(^|[:\-_/])cloud$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        static readonly object CacheLock = new object();
        static List<Dictionary<string, object>> _tagsCache;
        static DateTime _tagsAt = DateTime.MinValue;

        static Ollama()
        {
            int port = 11434;
            string warn = null;
            string env = Environment.GetEnvironmentVariable("OLLAMA_HOST");
            if (!string.IsNullOrWhiteSpace(env))
            {
                string h = env.Trim();
                int scheme = h.IndexOf("://", StringComparison.Ordinal);
                if (scheme >= 0) h = h.Substring(scheme + 3);
                h = h.TrimEnd('/');
                string host = h;
                int p = port;
                int colon = h.LastIndexOf(':');
                if (colon >= 0 && h.IndexOf(']') < colon)
                {
                    host = h.Substring(0, colon);
                    int.TryParse(h.Substring(colon + 1), out p);
                    if (p <= 0 || p > 65535) p = port;
                }
                host = host.Trim('[', ']').ToLowerInvariant();
                bool local = host == "" || host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "0.0.0.0" || host == "::";
                if (local) port = p;
                else warn = "OLLAMA_HOST points at another machine (" + env + "). Hearth ignores it and only uses Ollama on this PC.";
            }
            Base = "http://127.0.0.1:" + port;
            EndpointWarning = warn;
        }

        // ---------------------------------------------------------------- transport

        public static HttpWebRequest Create(string method, string path, int timeoutMs)
        {
            var uri = new Uri(Base + path);
            if (!uri.IsLoopback) throw new ApiException(500, "Refusing to contact a non-local AI endpoint.");
            var req = (HttpWebRequest)WebRequest.Create(uri);
            req.Method = method;
            req.Proxy = null;                 // never route local inference through a proxy
            req.AllowAutoRedirect = false;    // a redirect could point somewhere else
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.KeepAlive = true;
            return req;
        }

        public static string Call(string method, string path, string body, int timeoutMs, out int status)
        {
            var req = Create(method, path, timeoutMs);
            if (body != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/json";
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException ex)
            {
                resp = ex.Response as HttpWebResponse;
                if (resp == null) throw new ApiException(503, "Ollama is not reachable on this PC (" + Base + ").");
            }
            using (resp)
            using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                status = (int)resp.StatusCode;
                return r.ReadToEnd();
            }
        }

        public static Dictionary<string, object> GetJson(string path, int timeoutMs = 8000)
        {
            int status;
            string text = Call("GET", path, null, timeoutMs, out status);
            if (status >= 400) throw new ApiException(502, ErrorText(text, "Ollama returned an error."));
            return J.ParseObj(text);
        }

        public static string ErrorText(string body, string fallback)
        {
            try
            {
                var d = J.Obj(J.Parse(body));
                string e = J.S(d, "error");
                if (!string.IsNullOrEmpty(e)) return e;
            }
            catch { }
            return fallback;
        }

        // ---------------------------------------------------------------- local-only checks

        /// <summary>True if a model name/tag is one of Ollama's hosted "cloud" variants.</summary>
        public static bool IsCloudName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            return CloudName.IsMatch(name.Trim());
        }

        /// <summary>Returns null when the installed model runs on this machine, otherwise the reason it does not.</summary>
        public static string RemoteReason(Dictionary<string, object> tag)
        {
            string host = J.S(tag, "remote_host", "");
            string remoteModel = J.S(tag, "remote_model", "");
            string name = J.S(tag, "name", "");
            if (!string.IsNullOrEmpty(host)) return "Runs on " + host + ", not on this PC";
            if (!string.IsNullOrEmpty(remoteModel)) return "Relayed to a remote model (" + remoteModel + ")";
            if (IsCloudName(name)) return "Cloud-hosted model";
            return null;
        }

        public static List<Dictionary<string, object>> Tags(bool fresh)
        {
            lock (CacheLock)
            {
                if (!fresh && _tagsCache != null && (DateTime.UtcNow - _tagsAt).TotalSeconds < 2) return _tagsCache;
            }
            var list = new List<Dictionary<string, object>>();
            foreach (object o in J.Arr(J.Get(GetJson("/api/tags"), "models")))
            {
                var d = J.Obj(o);
                if (d != null) list.Add(d);
            }
            lock (CacheLock) { _tagsCache = list; _tagsAt = DateTime.UtcNow; }
            return list;
        }

        public static void InvalidateTags() { lock (CacheLock) { _tagsCache = null; } }

        /// <summary>Throws unless <paramref name="model"/> is installed AND executes on local hardware.</summary>
        public static void RequireLocalModel(string model)
        {
            if (string.IsNullOrWhiteSpace(model)) throw new ApiException(400, "Choose a model first.");
            if (IsCloudName(model)) throw new ApiException(403, "\"" + model + "\" is a cloud model. Hearth only runs models on this PC.");
            string wanted = model.IndexOf(':') < 0 ? model + ":latest" : model;
            foreach (var t in Tags(true))
            {
                string n = J.S(t, "name", "");
                if (!string.Equals(n, wanted, StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(n, model, StringComparison.OrdinalIgnoreCase)) continue;
                string reason = RemoteReason(t);
                if (reason != null) throw new ApiException(403, "\"" + model + "\" is blocked: " + reason + ". Hearth only runs models on this PC.");
                return;
            }
            throw new ApiException(404, "\"" + model + "\" is not installed. Download it from the Models page first.");
        }

        public static void RequireLocalPull(string name)
        {
            if (string.IsNullOrWhiteSpace(name) || name.Length > 200 || !Regex.IsMatch(name, @"^[A-Za-z0-9][\w.\-/]*(:[\w.\-]+)?$"))
                throw new ApiException(400, "That does not look like a valid model name.");
            if (IsCloudName(name)) throw new ApiException(403, "\"" + name + "\" is a cloud model and cannot run on this PC, so Hearth will not add it.");
        }
    }
}
