using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>Projects, settings and chat history. Everything is plain JSON under %LOCALAPPDATA%\Hearth.</summary>
    static class Store
    {
        public static string DataDir;
        static string ConfigPath, ChatsDir, SessionPath;
        static readonly object Lock = new object();
        static Dictionary<string, object> _config;

        public static void Init()
        {
            DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hearth");
            ChatsDir = Path.Combine(DataDir, "chats");
            ConfigPath = Path.Combine(DataDir, "config.json");
            SessionPath = Path.Combine(DataDir, "session.txt");
            Directory.CreateDirectory(ChatsDir);
            lock (Lock) { Load(); }
        }

        static void Load()
        {
            _config = null;
            try
            {
                if (File.Exists(ConfigPath)) _config = J.Obj(J.Parse(File.ReadAllText(ConfigPath, Encoding.UTF8)));
            }
            catch { }
            if (_config == null) _config = new Dictionary<string, object>();
            if (!(J.Get(_config, "settings") is Dictionary<string, object>)) _config["settings"] = new Dictionary<string, object>();
            var projects = ProjectList();
            if (projects.Count == 0)
            {
                projects.Add(J.Make("id", NewId("p"), "name", "General", "path", "", "model", "", "systemPrompt", ""));
            }
            _config["projects"] = projects.Cast<object>().ToList();
            Save();
        }

        static void Save()
        {
            WriteAtomic(ConfigPath, J.Str(_config));
        }

        static void WriteAtomic(string path, string text)
        {
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        public static string NewId(string prefix)
        {
            return prefix + "_" + Guid.NewGuid().ToString("N").Substring(0, 12);
        }

        static void CheckId(string id)
        {
            if (string.IsNullOrEmpty(id) || !Regex.IsMatch(id, @"^[A-Za-z0-9_]{3,40}$")) throw new ApiException(400, "Invalid id.");
        }

        // ---------------------------------------------------------------- session (single instance)

        public static void WriteSessionUrl(string url) { try { File.WriteAllText(SessionPath, url); } catch { } }
        public static string ReadSessionUrl() { try { return File.Exists(SessionPath) ? File.ReadAllText(SessionPath).Trim() : null; } catch { return null; } }
        public static void ClearSessionUrl() { try { File.Delete(SessionPath); } catch { } }

        // ---------------------------------------------------------------- settings

        public static Dictionary<string, object> Settings()
        {
            lock (Lock) { return new Dictionary<string, object>((Dictionary<string, object>)_config["settings"]); }
        }

        public static Dictionary<string, object> UpdateSettings(Dictionary<string, object> patch)
        {
            lock (Lock)
            {
                var s = (Dictionary<string, object>)_config["settings"];
                foreach (var kv in patch) s[kv.Key] = kv.Value;
                Save();
                return new Dictionary<string, object>(s);
            }
        }

        // ---------------------------------------------------------------- projects

        static List<Dictionary<string, object>> ProjectList()
        {
            var list = new List<Dictionary<string, object>>();
            foreach (object o in J.Arr(J.Get(_config, "projects")))
            {
                var d = J.Obj(o);
                if (d != null && !string.IsNullOrEmpty(J.S(d, "id"))) list.Add(d);
            }
            return list;
        }

        public static List<Dictionary<string, object>> Projects()
        {
            lock (Lock)
            {
                var list = new List<Dictionary<string, object>>();
                foreach (var p in ProjectList())
                {
                    var c = new Dictionary<string, object>(p);
                    string path = J.S(p, "path", "");
                    c["missing"] = path != "" && !Directory.Exists(path);
                    list.Add(c);
                }
                return list;
            }
        }

        public static Dictionary<string, object> Project(string id)
        {
            lock (Lock)
            {
                foreach (var p in ProjectList()) if (J.S(p, "id") == id) return p;
            }
            throw new ApiException(404, "That project no longer exists.");
        }

        public static string NormalizeFolder(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "";
            string full;
            try { full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim().Trim('"'))); }
            catch { throw new ApiException(400, "That folder path is not valid."); }
            if (!Directory.Exists(full)) throw new ApiException(400, "Folder not found: " + full);
            full = full.Length > 3 ? full.TrimEnd('\\') : full;
            Guard.RequireSafeProjectRoot(full);
            return full;
        }

        /// <summary>Paths (project-relative, forward slashes) the user has locked in this project.</summary>
        public static List<string> Protected(string projectId)
        {
            var p = Project(projectId);
            lock (Lock)
            {
                return J.Arr(J.Get(p, "protected")).Select(x => x as string).Where(x => !string.IsNullOrEmpty(x)).ToList();
            }
        }

        public static List<string> SetProtected(string projectId, string rel, bool on)
        {
            lock (Lock)
            {
                var list = ProjectList();
                var p = list.FirstOrDefault(x => J.S(x, "id") == projectId);
                if (p == null) throw new ApiException(404, "That project no longer exists.");
                var cur = J.Arr(J.Get(p, "protected")).Select(x => x as string).Where(x => !string.IsNullOrEmpty(x)).ToList();
                cur.RemoveAll(x => x.Equals(rel, StringComparison.OrdinalIgnoreCase));
                if (on) cur.Add(rel);
                p["protected"] = cur.Cast<object>().ToList();
                _config["projects"] = list.Cast<object>().ToList();
                Save();
                return cur;
            }
        }

        public static Dictionary<string, object> AddProject(string name, string path)
        {
            string folder = NormalizeFolder(path);
            if (string.IsNullOrWhiteSpace(name)) name = folder == "" ? "Untitled project" : new DirectoryInfo(folder).Name;
            lock (Lock)
            {
                var list = ProjectList();
                var p = J.Make("id", NewId("p"), "name", name.Trim(), "path", folder, "model", "", "systemPrompt", "");
                list.Add(p);
                _config["projects"] = list.Cast<object>().ToList();
                Save();
                return p;
            }
        }

        public static Dictionary<string, object> UpdateProject(string id, Dictionary<string, object> patch)
        {
            lock (Lock)
            {
                var list = ProjectList();
                var p = list.FirstOrDefault(x => J.S(x, "id") == id);
                if (p == null) throw new ApiException(404, "That project no longer exists.");
                if (patch.ContainsKey("name") && !string.IsNullOrWhiteSpace(J.S(patch, "name"))) p["name"] = J.S(patch, "name").Trim();
                if (patch.ContainsKey("path"))
                {
                    string folder = NormalizeFolder(J.S(patch, "path", ""));
                    if (!string.Equals(folder, J.S(p, "path", ""), StringComparison.OrdinalIgnoreCase)) p["protected"] = new List<object>();
                    p["path"] = folder;
                }
                if (patch.ContainsKey("model")) p["model"] = J.S(patch, "model", "");
                if (patch.ContainsKey("systemPrompt")) p["systemPrompt"] = J.S(patch, "systemPrompt", "");
                _config["projects"] = list.Cast<object>().ToList();
                Save();
                return p;
            }
        }

        /// <summary>Removes the project from Hearth and deletes its chat history. Files in the linked folder are never touched.</summary>
        public static void RemoveProject(string id)
        {
            CheckId(id);
            lock (Lock)
            {
                var list = ProjectList();
                if (list.Count <= 1) throw new ApiException(400, "Keep at least one project.");
                list.RemoveAll(x => J.S(x, "id") == id);
                _config["projects"] = list.Cast<object>().ToList();
                Save();
                string dir = Path.Combine(ChatsDir, id);
                try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { }
            }
        }

        // ---------------------------------------------------------------- chats

        static string ChatDir(string projectId)
        {
            CheckId(projectId);
            string d = Path.Combine(ChatsDir, projectId);
            Directory.CreateDirectory(d);
            return d;
        }

        static List<Dictionary<string, object>> ReadIndex(string dir)
        {
            var list = new List<Dictionary<string, object>>();
            string p = Path.Combine(dir, "index.json");
            try
            {
                if (File.Exists(p))
                    foreach (object o in J.Arr(J.Parse(File.ReadAllText(p, Encoding.UTF8))))
                    {
                        var d = J.Obj(o);
                        if (d != null) list.Add(d);
                    }
            }
            catch { }
            return list;
        }

        public static List<Dictionary<string, object>> ListChats(string projectId)
        {
            lock (Lock)
            {
                var list = ReadIndex(ChatDir(projectId));
                return list.OrderByDescending(x => J.L(x, "updated")).ToList();
            }
        }

        public static string ReadChat(string projectId, string chatId)
        {
            CheckId(chatId);
            string p = Path.Combine(ChatDir(projectId), chatId + ".json");
            if (!File.Exists(p)) throw new ApiException(404, "That chat no longer exists.");
            return File.ReadAllText(p, Encoding.UTF8);
        }

        public static void SaveChat(string projectId, string rawJson)
        {
            var chat = J.ParseObj(rawJson);
            string id = J.S(chat, "id");
            CheckId(id);
            int count = J.Arr(J.Get(chat, "messages")).Count();
            lock (Lock)
            {
                string dir = ChatDir(projectId);
                WriteAtomic(Path.Combine(dir, id + ".json"), rawJson);
                var index = ReadIndex(dir);
                index.RemoveAll(x => J.S(x, "id") == id);
                index.Add(J.Make(
                    "id", id,
                    "title", J.S(chat, "title", "New chat"),
                    "model", J.S(chat, "model", ""),
                    "updated", J.L(chat, "updated"),
                    "count", count));
                WriteAtomic(Path.Combine(dir, "index.json"), J.Str(index));
            }
        }

        public static void DeleteChat(string projectId, string chatId)
        {
            CheckId(chatId);
            lock (Lock)
            {
                string dir = ChatDir(projectId);
                try { File.Delete(Path.Combine(dir, chatId + ".json")); } catch { }
                var index = ReadIndex(dir);
                index.RemoveAll(x => J.S(x, "id") == chatId);
                WriteAtomic(Path.Combine(dir, "index.json"), J.Str(index));
            }
        }
    }
}
