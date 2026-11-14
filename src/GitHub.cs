using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>
    /// GITHUB SIGN-IN AND PROJECT UPLOAD.
    ///
    /// Sign-in is delegated to Git's own credential system (Git Credential Manager, which ships with
    /// Git for Windows and opens GitHub's sign-in window), so Hearth never sees a password. The access
    /// token Git hands back is used only inside this class, only for requests to api.github.com, and is
    /// never written to disk by Hearth, logged, or sent to the interface.
    ///
    /// Uploading keeps the file guardrails: credential files, sensitive folders and anything the user
    /// marked as protected are excluded, and the upload is refused if any of them is already tracked.
    /// Nothing is uploaded unless the user presses the button, and new repositories are private unless
    /// the user chooses otherwise.
    /// </summary>
    static class GitHub
    {
        const string ApiBase = "https://api.github.com";
        static readonly object Lock = new object();
        static string _gitPath;
        static bool _gitSearched;
        static string _cachedKey;
        static Dictionary<string, object> _cachedUser;
        static DateTime _cachedAt;

        class GitResult
        {
            public int Code = -1;
            public string Out = "", Err = "";
            public bool TimedOut;
            public bool Ok { get { return Code == 0 && !TimedOut; } }
        }

        // ---------------------------------------------------------------- running git

        static string GitPath()
        {
            lock (Lock)
            {
                if (_gitSearched) return _gitPath;
                _gitSearched = true;
                var candidates = new List<string>();
                foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                    if (!string.IsNullOrWhiteSpace(dir)) candidates.Add(Path.Combine(dir.Trim().Trim('"'), "git.exe"));
                foreach (string root in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramW6432"),
                    Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs") })
                    if (!string.IsNullOrEmpty(root)) candidates.Add(Path.Combine(root, "Git\\cmd\\git.exe"));
                foreach (string c in candidates)
                {
                    try { if (File.Exists(c)) { _gitPath = c; break; } } catch { }
                }
                return _gitPath;
            }
        }

        static void RequireGit()
        {
            if (GitPath() == null) throw new ApiException(424, "Git for Windows is not installed on this PC. Install it, then reopen Hearth.");
        }

        static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
            var sb = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in a)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { sb.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
                sb.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return sb.Append('\\', slashes * 2).Append('"').ToString();
        }

        static GitResult Git(string cwd, string stdin, int timeoutMs, bool interactive, params string[] args)
        {
            var all = new List<string> { "-c", "core.askPass=", "-c", "core.quotePath=false" };
            all.AddRange(args);
            var psi = new ProcessStartInfo(GitPath(), string.Join(" ", all.Select(Quote)))
            {
                WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";                      // never wait on a hidden console
            psi.EnvironmentVariables["GCM_INTERACTIVE"] = interactive ? "auto" : "never"; // sign-in windows only when asked for
            var result = new GitResult();
            var so = new StringBuilder();
            var se = new StringBuilder();
            using (var p = new Process { StartInfo = psi })
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (so) so.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (se) se.AppendLine(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                try { if (stdin != null) p.StandardInput.Write(stdin); p.StandardInput.Close(); } catch { }
                if (!p.WaitForExit(timeoutMs))
                {
                    result.TimedOut = true;
                    try { p.Kill(); } catch { }
                }
                else
                {
                    p.WaitForExit();
                    result.Code = p.ExitCode;
                }
            }
            lock (so) result.Out = so.ToString().Trim();
            lock (se) result.Err = se.ToString().Trim();
            return result;
        }

        static GitResult Git(string cwd, params string[] args) { return Git(cwd, null, 120000, false, args); }

        static string GitError(GitResult r, string fallback)
        {
            if (r.TimedOut) return fallback + " (it took too long and was stopped)";
            string text = (r.Err != "" ? r.Err : r.Out).Trim();
            string last = text.Split('\n').Select(x => x.Trim()).LastOrDefault(x => x != "") ?? "";
            last = Regex.Replace(last, @"^(fatal|error|remote):\s*", "", RegexOptions.IgnoreCase);
            return last == "" ? fallback : fallback + ": " + last;
        }

        // ---------------------------------------------------------------- credentials (never leave this class)

        const string CredentialRequest = "protocol=https\nhost=github.com\n\n";

        static Dictionary<string, string> CredentialFill(bool interactive)
        {
            var r = Git(Path.GetTempPath(), CredentialRequest, interactive ? 300000 : 20000, interactive, "credential", "fill");
            if (!r.Ok) return null;
            var d = new Dictionary<string, string>();
            foreach (string line in r.Out.Split('\n'))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) d[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
            return d.ContainsKey("password") && d["password"] != "" ? d : null;
        }

        static string CredentialBlock(Dictionary<string, string> c)
        {
            return "protocol=https\nhost=github.com\nusername=" + (c.ContainsKey("username") ? c["username"] : "") + "\npassword=" + c["password"] + "\n\n";
        }

        static bool SignsInThroughCli()
        {
            var r = Git(Path.GetTempPath(), "config", "--get-all", "credential.https://github.com.helper");
            return r.Out.IndexOf("gh", StringComparison.OrdinalIgnoreCase) >= 0 && r.Out.IndexOf("auth git-credential", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // ---------------------------------------------------------------- GitHub API (api.github.com only)

        static Dictionary<string, object> Api(string method, string path, string token, object body, out int status)
        {
            var uri = new Uri(ApiBase + path);
            if (uri.Host != "api.github.com" || uri.Scheme != "https") throw new ApiException(500, "Refusing to send GitHub credentials anywhere but api.github.com.");
            var req = (HttpWebRequest)WebRequest.Create(uri);
            req.Method = method;
            req.Timeout = 30000;
            req.AllowAutoRedirect = false;
            req.UserAgent = "Hearth-desktop";
            req.Accept = "application/vnd.github+json";
            req.Headers["Authorization"] = "Bearer " + token;
            req.Headers["X-GitHub-Api-Version"] = "2022-11-28";
            if (body != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(J.Str(body));
                req.ContentType = "application/json";
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException ex)
            {
                resp = ex.Response as HttpWebResponse;
                if (resp == null) throw new ApiException(502, "Could not reach GitHub. Check your internet connection.");
            }
            using (resp)
            using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                status = (int)resp.StatusCode;
                string text = r.ReadToEnd();
                try { return J.Obj(J.Parse(text)) ?? new Dictionary<string, object>(); }
                catch { return new Dictionary<string, object>(); }
            }
        }

        static Dictionary<string, object> Me(string token)
        {
            string key;
            using (var sha = SHA256.Create()) key = Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(token)));
            lock (Lock)
            {
                if (_cachedKey == key && _cachedUser != null && (DateTime.UtcNow - _cachedAt).TotalMinutes < 5) return _cachedUser;
            }
            int status;
            var u = Api("GET", "/user", token, null, out status);
            if (status == 401) return null;
            if (status >= 400 || string.IsNullOrEmpty(J.S(u, "login"))) throw new ApiException(502, "GitHub did not accept the request (" + status + ").");
            lock (Lock) { _cachedKey = key; _cachedUser = u; _cachedAt = DateTime.UtcNow; }
            return u;
        }

        // ---------------------------------------------------------------- account

        public static object Status()
        {
            var s = J.Make("git", GitPath() != null, "signedIn", false, "login", "", "name", "", "viaCli", false);
            if (GitPath() == null) return s;
            try
            {
                var cred = CredentialFill(false);
                if (cred == null) return s;
                var me = Me(cred["password"]);
                if (me == null) return s;
                s["signedIn"] = true;
                s["login"] = J.S(me, "login", "");
                s["name"] = J.S(me, "name", "");
                s["viaCli"] = SignsInThroughCli();
            }
            catch (ApiException ex) { s["error"] = ex.Message; }
            return s;
        }

        /// <summary>Opens GitHub's sign-in window (through Git Credential Manager) and waits for the user to finish.</summary>
        public static object SignIn()
        {
            RequireGit();
            var cred = CredentialFill(true);
            if (cred == null)
                throw new ApiException(401, SignsInThroughCli()
                    ? "Git on this PC signs in through the GitHub CLI. Run \"gh auth login\" once, then come back."
                    : "The GitHub sign-in was cancelled or did not finish.");
            var me = Me(cred["password"]);
            if (me == null)
            {
                Git(Path.GetTempPath(), CredentialBlock(cred), 20000, false, "credential", "reject");
                throw new ApiException(401, "GitHub did not accept that sign-in. Please try again.");
            }
            Git(Path.GetTempPath(), CredentialBlock(cred), 20000, false, "credential", "approve");   // remembered by Windows, not by Hearth
            return Status();
        }

        public static object SignOut()
        {
            RequireGit();
            var cred = CredentialFill(false);
            if (cred != null) Git(Path.GetTempPath(), CredentialBlock(cred), 20000, false, "credential", "reject");
            lock (Lock) { _cachedKey = null; _cachedUser = null; }
            if (CredentialFill(false) != null && SignsInThroughCli())
                throw new ApiException(409, "This PC is signed in through the GitHub CLI, which Hearth cannot sign out. Run \"gh auth logout\" to sign out.");
            return Status();
        }

        // ---------------------------------------------------------------- project state

        static string ProjectRoot(string projectId)
        {
            string root = J.S(Store.Project(projectId), "path", "");
            if (root == "") throw new ApiException(400, "Link a folder to this project first.");
            if (!Directory.Exists(root)) throw new ApiException(404, "The project folder is missing: " + root);
            return root;
        }

        static string WebUrl(string remote)
        {
            Match m = Regex.Match(remote ?? "", @"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.\-]+)/([\w.\-]+?)(?:\.git)?/?$", RegexOptions.IgnoreCase);
            return m.Success ? "https://github.com/" + m.Groups[1].Value + "/" + m.Groups[2].Value : null;
        }

        static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        /// <summary>"own" = the folder is its own repository, "nested" = it sits inside a bigger one, "none" = not a repository.</summary>
        static string RepoKind(string root, out string top)
        {
            top = "";
            var r = Git(root, "rev-parse", "--show-toplevel");
            if (!r.Ok) return "none";
            top = r.Out.Replace('/', '\\');
            return SamePath(top, root) ? "own" : "nested";
        }

        public static object ProjectStatus(string projectId)
        {
            string root = ProjectRoot(projectId);
            var s = J.Make("git", GitPath() != null, "repo", false, "nested", false, "remote", "", "web", "", "branch", "", "changes", 0, "commits", false,
                "suggested", Regex.Replace(Regex.Replace(J.S(Store.Project(projectId), "name", "project").Trim(), @"[^A-Za-z0-9._-]+", "-"), @"^-+|-+$", ""));
            if (GitPath() == null) return s;
            string top;
            string kind = RepoKind(root, out top);
            if (kind == "nested") { s["nested"] = true; s["top"] = top; return s; }
            if (kind == "none") return s;
            s["repo"] = true;
            s["commits"] = Git(root, "rev-parse", "--verify", "-q", "HEAD").Ok;
            s["branch"] = Git(root, "rev-parse", "--abbrev-ref", "HEAD").Out;
            var st = Git(root, "status", "--porcelain");
            s["changes"] = st.Out == "" ? 0 : st.Out.Split('\n').Length;
            var rem = Git(root, "remote", "get-url", "origin");
            if (rem.Ok && rem.Out != "")
            {
                string web = WebUrl(rem.Out);
                s["remote"] = web ?? "another Git server";      // never echo a raw remote: it could embed credentials
                s["web"] = web ?? "";
                if (web != null && (bool)s["commits"])
                {
                    var ahead = Git(root, "rev-list", "--count", "@{upstream}..HEAD");
                    s["unpushed"] = ahead.Ok ? ahead.Out : "";
                }
            }
            return s;
        }

        // ---------------------------------------------------------------- upload

        const string ExcludeBegin = "# >>> hearth guardrails (managed by Hearth, rewritten on every upload)";
        const string ExcludeEnd = "# <<< hearth guardrails";

        /// <summary>Keeps protected files out of the upload without adding or changing any file in the project itself.</summary>
        static void WriteExcludes(string root, List<string> userProtected)
        {
            string info = Path.Combine(root, ".git", "info");
            Directory.CreateDirectory(info);
            string path = Path.Combine(info, "exclude");
            string existing = File.Exists(path) ? File.ReadAllText(path) : "";
            int a = existing.IndexOf(ExcludeBegin, StringComparison.Ordinal);
            int b = existing.IndexOf(ExcludeEnd, StringComparison.Ordinal);
            if (a >= 0 && b > a) existing = existing.Remove(a, b + ExcludeEnd.Length - a);
            var sb = new StringBuilder(existing.TrimEnd());
            if (sb.Length > 0) sb.Append("\n\n");
            sb.Append(ExcludeBegin).Append('\n');
            foreach (string p in Guard.IgnorePatterns()) sb.Append(p).Append('\n');
            foreach (string u in userProtected) sb.Append('/').Append(u.Replace("\\", "/").Replace(" ", "\\ ")).Append('\n');
            sb.Append(ExcludeEnd).Append('\n');
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        /// <summary>Streams progress as newline-delimited JSON: {"step": "..."} lines, then {"done": true, ...} or {"error": "..."}.</summary>
        public static void Upload(HttpListenerResponse res, Dictionary<string, object> body)
        {
            string projectId = J.S(body, "project");
            string root = ProjectRoot(projectId);
            RequireGit();
            var cred = CredentialFill(false);
            var me = cred == null ? null : Me(cred["password"]);
            if (me == null) throw new ApiException(401, "Sign in to GitHub first.");
            string token = cred["password"];
            string login = J.S(me, "login");

            res.StatusCode = 200;
            res.ContentType = "application/x-ndjson; charset=utf-8";
            res.SendChunked = true;
            Action<Dictionary<string, object>> emit = o =>
            {
                byte[] line = Encoding.UTF8.GetBytes(J.Str(o) + "\n");
                try { res.OutputStream.Write(line, 0, line.Length); res.OutputStream.Flush(); } catch { }
            };
            try
            {
                var prot = Store.Protected(projectId);

                emit(J.Make("step", "Checking the project folder"));
                string top;
                string kind = RepoKind(root, out top);
                if (kind == "nested") throw new ApiException(409, "This folder is part of a larger Git repository (" + top + "). Hearth only uploads folders that are their own repository.");
                if (kind == "none")
                {
                    var init = Git(root, "init", "-b", "main");
                    if (!init.Ok) throw new ApiException(500, GitError(init, "Could not prepare the folder for Git"));
                }

                string remoteUrl = "";
                var rem = Git(root, "remote", "get-url", "origin");
                if (rem.Ok && rem.Out != "")
                {
                    remoteUrl = rem.Out;
                    if (WebUrl(remoteUrl) == null) throw new ApiException(409, "This project is already connected to a Git server that is not GitHub, so Hearth will not upload it.");
                }
                string repoName = J.S(body, "name", "").Trim();
                if (remoteUrl == "" && !Regex.IsMatch(repoName, @"^[A-Za-z0-9._-]{1,100}$"))
                    throw new ApiException(400, "Repository names can only use letters, numbers, dots, dashes and underscores.");

                emit(J.Make("step", "Leaving out protected files"));
                WriteExcludes(root, prot);
                var add = Git(root, null, 300000, false, "add", "-A");
                if (!add.Ok) throw new ApiException(500, GitError(add, "Could not collect the project's files"));

                // The guardrail that matters: nothing locked may be in what gets uploaded, even if it was tracked before.
                var tracked = Git(root, null, 120000, false, "ls-files");
                var files = tracked.Out == "" ? new string[0] : tracked.Out.Split('\n').Select(x => x.Trim()).Where(x => x != "").ToArray();
                var lockedFiles = files.Where(f => Guard.Reason(f, false, prot) != null).ToList();
                if (lockedFiles.Count > 0)
                {
                    if (kind == "none") Git(root, "rm", "-r", "--cached", "-q", ".");
                    throw new ApiException(403, "Upload stopped: " + lockedFiles.Count + " protected file" + (lockedFiles.Count == 1 ? " is" : "s are") +
                        " already tracked by Git in this project (" + string.Join(", ", lockedFiles.Take(4)) + (lockedFiles.Count > 4 ? ", …" : "") +
                        "). Remove " + (lockedFiles.Count == 1 ? "it" : "them") + " from Git first; Hearth will not upload protected files.");
                }
                if (files.Length == 0) throw new ApiException(400, "There is nothing to upload: the folder has no files that are allowed to leave this PC.");

                bool hasCommits = Git(root, "rev-parse", "--verify", "-q", "HEAD").Ok;
                bool staged = !Git(root, "diff", "--cached", "--quiet").Ok;
                if (staged || !hasCommits)
                {
                    emit(J.Make("step", "Saving a snapshot of " + files.Length + " file" + (files.Length == 1 ? "" : "s")));
                    string message = J.S(body, "message", "").Trim();
                    if (message == "") message = hasCommits ? "Update from Hearth" : "Initial upload from Hearth";
                    var args = new List<string>();
                    if (Git(root, "config", "user.email").Out == "")
                    {
                        // No identity configured: use GitHub's private no-reply address rather than a real email.
                        args.AddRange(new[] { "-c", "user.name=" + (J.S(me, "name", "") != "" ? J.S(me, "name") : login),
                                              "-c", "user.email=" + J.L(me, "id") + "+" + login + "@users.noreply.github.com" });
                    }
                    args.AddRange(new[] { "commit", "-q", "-m", message });
                    var commit = Git(root, null, 300000, false, args.ToArray());
                    if (!commit.Ok) throw new ApiException(500, GitError(commit, "Could not save the snapshot"));
                }

                string web;
                if (remoteUrl == "")
                {
                    object priv = J.Get(body, "private");
                    bool isPrivate = !(priv is bool) || (bool)priv;        // private unless the user explicitly chose public
                    emit(J.Make("step", "Creating " + (isPrivate ? "private" : "public") + " repository " + login + "/" + repoName));
                    int status;
                    var created = Api("POST", "/user/repos", token,
                        J.Make("name", repoName, "private", isPrivate, "description", J.S(body, "description", "").Trim(), "auto_init", false), out status);
                    if (status == 422) throw new ApiException(409, "You already have a repository called \"" + repoName + "\" on GitHub. Choose another name.");
                    if (status >= 400) throw new ApiException(502, "GitHub could not create the repository (" + status + (J.S(created, "message", "") != "" ? ": " + J.S(created, "message") : "") + ").");
                    string clone = J.S(created, "clone_url", "");
                    web = WebUrl(clone);
                    if (web == null) throw new ApiException(502, "GitHub returned an unexpected repository address.");
                    var addRemote = Git(root, "remote", "add", "origin", clone);
                    if (!addRemote.Ok) throw new ApiException(500, GitError(addRemote, "Could not connect the folder to the new repository"));
                }
                else web = WebUrl(remoteUrl);

                emit(J.Make("step", "Uploading to GitHub"));
                var push = Git(root, null, 1200000, false, "push", "-u", "origin", "HEAD");
                if (!push.Ok) throw new ApiException(502, GitError(push, "The upload did not finish"));

                emit(J.Make("done", true, "url", web, "files", files.Length,
                    "commit", Git(root, "rev-parse", "--short", "HEAD").Out));
            }
            catch (ApiException ex) { emit(J.Make("error", ex.Message)); }
            catch (Exception ex) { emit(J.Make("error", "The upload failed: " + ex.Message)); }
        }

        /// <summary>Opens a page in the user's own browser (where they are signed in). Only the two sites Hearth links to.</summary>
        public static void OpenInBrowser(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u) || u.Scheme != "https" || (u.Host != "github.com" && u.Host != "git-scm.com"))
                throw new ApiException(400, "Hearth only opens github.com and git-scm.com links.");
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
    }
}
