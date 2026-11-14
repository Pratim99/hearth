using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>
    /// GITHUB SIGN-IN AND PROJECT UPLOAD, through the official tools.
    ///
    /// Hearth does not talk to GitHub itself and never holds a password or access token. Signing in,
    /// creating a repository and uploading are all done by the GitHub CLI ("gh") and Git, which the
    /// user installs separately; Hearth only starts them and reports what they say.
    ///
    /// Uploading keeps the file guardrails: credential files, sensitive folders and anything the user
    /// marked as protected are left out, and the upload is refused if any of them is already tracked.
    /// Nothing is uploaded unless the user presses the button, and new repositories are private unless
    /// the user chooses otherwise.
    /// </summary>
    static class GitHub
    {
        static readonly object Lock = new object();
        static string _git, _gh;
        static bool _searched;

        class RunResult
        {
            public int Code = -1;
            public string Out = "", Err = "";
            public bool TimedOut;
            public bool Ok { get { return Code == 0 && !TimedOut; } }
        }

        // ---------------------------------------------------------------- finding and running the tools

        static string Find(string exe, params string[] wellKnown)
        {
            var candidates = new List<string>();
            foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                if (!string.IsNullOrWhiteSpace(dir)) candidates.Add(Path.Combine(dir.Trim().Trim('"'), exe));
            foreach (string root in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramW6432"),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs") })
                if (!string.IsNullOrEmpty(root))
                    foreach (string rel in wellKnown) candidates.Add(Path.Combine(root, rel));
            foreach (string c in candidates)
            {
                try { if (File.Exists(c)) return c; } catch { }
            }
            return null;
        }

        static void Locate()
        {
            lock (Lock)
            {
                if (_searched && _git != null && _gh != null) return;
                _searched = true;
                if (_git == null) _git = Find("git.exe", "Git\\cmd\\git.exe");
                if (_gh == null) _gh = Find("gh.exe", "GitHub CLI\\gh.exe");
            }
        }

        static void RequireTools()
        {
            Locate();
            if (_git == null) throw new ApiException(424, "Git for Windows is not installed on this PC.");
            if (_gh == null) throw new ApiException(424, "The GitHub CLI is not installed on this PC.");
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

        static ProcessStartInfo StartInfo(string exe, string cwd, IEnumerable<string> args)
        {
            var psi = new ProcessStartInfo(exe, string.Join(" ", args.Select(Quote)))
            {
                WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            // The GitHub CLI runs Git itself, so make sure both tools can find each other even when they
            // were installed after this Windows session started (and so are not on PATH yet).
            var dirs = new List<string>();
            if (_git != null) dirs.Add(Path.GetDirectoryName(_git));
            if (_gh != null) dirs.Add(Path.GetDirectoryName(_gh));
            dirs.Add(Environment.GetEnvironmentVariable("PATH") ?? "");
            psi.EnvironmentVariables["PATH"] = string.Join(";", dirs);
            psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";     // never wait on a hidden console
            psi.EnvironmentVariables["GCM_INTERACTIVE"] = "never";
            psi.EnvironmentVariables["GH_PROMPT_DISABLED"] = "1";
            psi.EnvironmentVariables["GH_NO_UPDATE_NOTIFIER"] = "1";
            psi.EnvironmentVariables["NO_COLOR"] = "1";
            return psi;
        }

        static RunResult Run(string exe, string cwd, int timeoutMs, params string[] args)
        {
            var result = new RunResult();
            var so = new StringBuilder();
            var se = new StringBuilder();
            using (var p = new Process { StartInfo = StartInfo(exe, cwd, args) })
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (so) so.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (se) se.AppendLine(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                try { p.StandardInput.Close(); } catch { }
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

        static RunResult Git(string cwd, params string[] args)
        {
            var all = new List<string> { "-c", "core.askPass=", "-c", "core.quotePath=false" };
            all.AddRange(args);
            return Run(_git, cwd, 300000, all.ToArray());
        }

        static RunResult Gh(string cwd, int timeoutMs, params string[] args) { return Run(_gh, cwd, timeoutMs, args); }

        static string Problem(RunResult r, string fallback)
        {
            if (r.TimedOut) return fallback + " (it took too long and was stopped)";
            string text = (r.Err != "" ? r.Err : r.Out).Trim();
            string last = text.Split('\n').Select(x => x.Trim()).LastOrDefault(x => x != "") ?? "";
            last = Regex.Replace(last, @"^(fatal|error|remote|GraphQL|HTTP \d+):\s*", "", RegexOptions.IgnoreCase);
            return last == "" ? fallback : fallback + ": " + last;
        }

        // ---------------------------------------------------------------- account

        static string SignedInAs()
        {
            var r = Gh(Path.GetTempPath(), 20000, "auth", "status", "--hostname", "github.com");
            if (!r.Ok) return null;
            Match m = Regex.Match(r.Out + "\n" + r.Err, @"Logged in to github\.com (?:account|as) ([A-Za-z0-9\-]+)");
            return m.Success ? m.Groups[1].Value : null;
        }

        public static object Status()
        {
            Locate();
            var s = J.Make("git", _git != null, "gh", _gh != null, "signedIn", false, "login", "");
            if (_git == null || _gh == null) return s;
            string login = SignedInAs();
            if (login != null) { s["signedIn"] = true; s["login"] = login; }
            return s;
        }

        /// <summary>
        /// Runs the GitHub CLI's browser sign-in. The CLI prints a one-time code and opens github.com;
        /// the code is passed to the window so the user can type it there. Streams newline-delimited JSON:
        /// {"code": "XXXX-XXXX"}, then {"done": true, "login": "..."} or {"error": "..."}.
        /// </summary>
        public static void SignIn(HttpListenerResponse res)
        {
            RequireTools();
            res.StatusCode = 200;
            res.ContentType = "application/x-ndjson; charset=utf-8";
            res.SendChunked = true;
            bool gone = false;
            Action<Dictionary<string, object>> emit = o =>
            {
                byte[] line = Encoding.UTF8.GetBytes(J.Str(o) + "\n");
                try { lock (res) { res.OutputStream.Write(line, 0, line.Length); res.OutputStream.Flush(); } } catch { gone = true; }
            };

            var output = new StringBuilder();
            DataReceivedEventHandler onLine = (s, e) =>
            {
                if (e.Data == null) return;
                lock (output) output.AppendLine(e.Data);
                // The CLI has worded this line in more than one way across versions; all of them carry XXXX-XXXX.
                Match m = Regex.Match(e.Data, @"one-time code\W{0,3}([A-Z0-9]{4}-[A-Z0-9]{4})", RegexOptions.IgnoreCase);
                if (m.Success) emit(J.Make("code", m.Groups[1].Value, "url", "https://github.com/login/device"));
            };
            using (var p = new Process { StartInfo = StartInfo(_gh, Path.GetTempPath(), new[] { "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web" }) })
            {
                p.OutputDataReceived += onLine;
                p.ErrorDataReceived += onLine;
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                try { p.StandardInput.Close(); } catch { }
                var started = DateTime.UtcNow;
                while (!p.WaitForExit(2000))
                {
                    emit(J.Make("waiting", true));                       // also tells us if the window went away
                    if (gone || (DateTime.UtcNow - started).TotalMinutes > 14)
                    {
                        try { p.Kill(); } catch { }
                        if (!gone) emit(J.Make("error", "The sign-in code expired before it was used. Try again."));
                        return;
                    }
                }
                p.WaitForExit();
                if (p.ExitCode != 0)
                {
                    string text;
                    lock (output) text = output.ToString();
                    string last = text.Split('\n').Select(x => x.Trim()).LastOrDefault(x => x != "" && !x.Contains("one-time code")) ?? "";
                    emit(J.Make("error", "GitHub sign-in did not finish" + (last != "" ? ": " + last : ".")));
                    return;
                }
            }
            string login = SignedInAs();
            if (login == null) emit(J.Make("error", "GitHub sign-in did not finish."));
            else emit(J.Make("done", true, "login", login));
        }

        public static object SignOut()
        {
            RequireTools();
            string login = SignedInAs();
            if (login != null)
            {
                var r = Gh(Path.GetTempPath(), 30000, "auth", "logout", "--hostname", "github.com", "--user", login);
                if (!r.Ok) throw new ApiException(500, Problem(r, "Could not sign out"));
            }
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
            Locate();
            var s = J.Make("repo", false, "nested", false, "remote", "", "web", "", "branch", "", "changes", 0, "commits", false,
                "suggested", Regex.Replace(Regex.Replace(J.S(Store.Project(projectId), "name", "project").Trim(), @"[^A-Za-z0-9._-]+", "-"), @"^-+|-+$", ""));
            if (_git == null) return s;
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
                s["remote"] = web ?? "another Git server";      // never echo a raw remote address
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
            RequireTools();
            string login = SignedInAs();
            if (login == null) throw new ApiException(401, "Sign in to GitHub first.");

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
                    if (!init.Ok) throw new ApiException(500, Problem(init, "Could not prepare the folder for Git"));
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
                var add = Git(root, "add", "-A");
                if (!add.Ok) throw new ApiException(500, Problem(add, "Could not collect the project's files"));

                // The guardrail that matters: nothing locked may be in what gets uploaded, even if it was tracked before.
                var tracked = Git(root, "ls-files");
                var files = tracked.Out == "" ? new string[0] : tracked.Out.Split('\n').Select(x => x.Trim()).Where(x => x != "").ToArray();
                var lockedFiles = files.Where(f => Guard.Reason(f, false, prot) != null).ToList();
                if (lockedFiles.Count > 0)
                    throw new ApiException(403, "Upload stopped: " + lockedFiles.Count + " protected file" + (lockedFiles.Count == 1 ? " is" : "s are") +
                        " already tracked by Git in this project (" + string.Join(", ", lockedFiles.Take(4)) + (lockedFiles.Count > 4 ? ", …" : "") +
                        "). Remove " + (lockedFiles.Count == 1 ? "it" : "them") + " from Git first; Hearth will not upload protected files.");
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
                        // No author configured in Git: use GitHub's private no-reply address rather than a real email.
                        var who = Gh(root, 30000, "api", "user");
                        var me = who.Ok ? J.Obj(J.Parse(who.Out)) : null;
                        if (me == null || J.L(me, "id") == 0) throw new ApiException(502, "Could not read your GitHub account details.");
                        args.AddRange(new[] { "-c", "user.name=" + (J.S(me, "name", "") != "" ? J.S(me, "name") : login),
                                              "-c", "user.email=" + J.L(me, "id") + "+" + login + "@users.noreply.github.com" });
                    }
                    args.AddRange(new[] { "commit", "-q", "-m", message });
                    var commit = Git(root, args.ToArray());
                    if (!commit.Ok) throw new ApiException(500, Problem(commit, "Could not save the snapshot"));
                }

                if (remoteUrl == "")
                {
                    object priv = J.Get(body, "private");
                    bool isPrivate = !(priv is bool) || (bool)priv;        // private unless the user explicitly chose public
                    emit(J.Make("step", "Creating " + (isPrivate ? "private" : "public") + " repository " + login + "/" + repoName + " and uploading"));
                    var create = new List<string> { "repo", "create", repoName, isPrivate ? "--private" : "--public", "--source", ".", "--remote", "origin", "--push" };
                    string description = J.S(body, "description", "").Trim();
                    if (description != "") { create.Add("--description"); create.Add(description); }
                    var made = Gh(root, 1200000, create.ToArray());
                    if (!made.Ok)
                    {
                        if ((made.Err + made.Out).IndexOf("already exists", StringComparison.OrdinalIgnoreCase) >= 0)
                            throw new ApiException(409, "You already have a repository called \"" + repoName + "\" on GitHub. Choose another name.");
                        throw new ApiException(502, Problem(made, "GitHub could not create the repository"));
                    }
                }
                else
                {
                    emit(J.Make("step", "Uploading to GitHub"));
                    // Let the GitHub CLI supply the sign-in for this one push, without changing Git's settings.
                    var push = Git(root, "-c", "credential.helper=", "-c", "credential.https://github.com.helper=!\"" + _gh.Replace('\\', '/') + "\" auth git-credential",
                        "push", "-u", "origin", "HEAD");
                    if (!push.Ok) throw new ApiException(502, Problem(push, "The upload did not finish"));
                }

                string web = WebUrl(Git(root, "remote", "get-url", "origin").Out) ?? "";
                emit(J.Make("done", true, "url", web, "files", files.Length, "commit", Git(root, "rev-parse", "--short", "HEAD").Out));
            }
            catch (ApiException ex) { emit(J.Make("error", ex.Message)); }
            catch (Exception ex) { emit(J.Make("error", "The upload failed: " + ex.Message)); }
        }

        /// <summary>Opens a page in the user's own browser (where they are signed in). Only the sites Hearth links to.</summary>
        public static void OpenInBrowser(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u) || u.Scheme != "https" || (u.Host != "github.com" && u.Host != "git-scm.com" && u.Host != "cli.github.com"))
                throw new ApiException(400, "Hearth only opens github.com, cli.github.com and git-scm.com links.");
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
    }
}
