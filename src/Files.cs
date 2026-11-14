using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Microsoft.VisualBasic.FileIO;

namespace Hearth
{
    /// <summary>
    /// Access to a project's linked folder. Every path is confined to that folder and every
    /// operation is cleared with <see cref="Guard"/> first. Deletes go to the Recycle Bin and
    /// nothing is ever overwritten by a create or a move.
    /// </summary>
    static class Files
    {
        const int MaxReadBytes = 2 * 1024 * 1024;
        static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build", "target",
            ".next", ".idea", ".vs", ".cache", "$RECYCLE.BIN", "System Volume Information"
        };

        // ---------------------------------------------------------------- path handling

        static string Root(string projectId)
        {
            string root = J.S(Store.Project(projectId), "path", "");
            if (root == "") throw new ApiException(400, "This project has no folder linked yet.");
            if (!Directory.Exists(root)) throw new ApiException(404, "The project folder is missing: " + root);
            return root;
        }

        static string Resolve(string root, string rel)
        {
            rel = (rel ?? "").Replace('/', '\\').TrimStart('\\');
            string full;
            try { full = Path.GetFullPath(Path.Combine(root, rel)); }
            catch { throw new ApiException(400, "Invalid path."); }
            string rootSlash = root.EndsWith("\\") ? root : root + "\\";
            if (!full.Equals(root, StringComparison.OrdinalIgnoreCase) &&
                !full.StartsWith(rootSlash, StringComparison.OrdinalIgnoreCase))
                throw new ApiException(403, "That path is outside the project folder.");

            // A link or junction part-way down the path could lead out of the project.
            string walk = full;
            while (walk != null && walk.Length > root.Length)
            {
                try
                {
                    if (Directory.Exists(walk) || File.Exists(walk))
                        if ((File.GetAttributes(walk) & FileAttributes.ReparsePoint) != 0)
                            throw new ApiException(403, "That path goes through a link to another location, so Hearth will not use it.");
                }
                catch (ApiException) { throw; }
                catch { }
                walk = Path.GetDirectoryName(walk);
            }
            return full;
        }

        static string Rel(string root, string full) { return Guard.Rel(root, full); }

        // ---------------------------------------------------------------- browsing

        public static object List(string projectId, string rel)
        {
            string root = Root(projectId);
            string dir = Resolve(root, rel);
            if (!Directory.Exists(dir)) throw new ApiException(404, "Folder not found.");
            var prot = Store.Protected(projectId);
            var entries = new List<object>();
            var info = new DirectoryInfo(dir);
            try
            {
                foreach (var d in info.GetDirectories().OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                    entries.Add(Entry(root, d, true, prot));
                foreach (var f in info.GetFiles().OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                    entries.Add(Entry(root, f, false, prot));
            }
            catch (UnauthorizedAccessException) { throw new ApiException(403, "Windows denied access to that folder."); }
            return J.Make("path", Rel(root, dir), "entries", entries);
        }

        static Dictionary<string, object> Entry(string root, FileSystemInfo it, bool isDir, List<string> prot)
        {
            string rel = Rel(root, it.FullName);
            string locked = Guard.Reason(rel, isDir, prot);
            if (locked == null && (it.Attributes & FileAttributes.ReparsePoint) != 0) locked = "it is a link to another location";
            if (locked == null && (it.Attributes & FileAttributes.System) != 0) locked = "Windows marks it as a system item";
            var e = J.Make("name", it.Name, "path", rel, "dir", isDir, "locked", locked,
                "userLocked", prot.Any(p => p.Equals(rel, StringComparison.OrdinalIgnoreCase)));
            if (!isDir) e["size"] = ((FileInfo)it).Length;
            return e;
        }

        public static object Find(string projectId, string query)
        {
            string root = Root(projectId);
            var prot = Store.Protected(projectId);
            string q = (query ?? "").Trim().ToLowerInvariant().Replace('\\', '/');
            var hits = new List<KeyValuePair<int, FileInfo>>();
            var stack = new Stack<DirectoryInfo>();
            stack.Push(new DirectoryInfo(root));
            int visited = 0;
            bool truncated = false;
            while (stack.Count > 0)
            {
                var dir = stack.Pop();
                FileInfo[] files; DirectoryInfo[] dirs;
                try { files = dir.GetFiles(); dirs = dir.GetDirectories(); }
                catch { continue; }
                foreach (var f in files)
                {
                    if (++visited > 40000) { truncated = true; break; }
                    string rel = Rel(root, f.FullName);
                    if (Guard.Reason(rel, false, prot) != null) continue;   // locked files are not offered
                    string lower = rel.ToLowerInvariant();
                    string name = f.Name.ToLowerInvariant();
                    int score;
                    if (q == "") score = 1;
                    else if (name == q) score = 100;
                    else if (name.StartsWith(q)) score = 80;
                    else if (name.Contains(q)) score = 60;
                    else if (lower.Contains(q)) score = 40;
                    else if (Subsequence(q, name)) score = 20;
                    else continue;
                    hits.Add(new KeyValuePair<int, FileInfo>(score, f));
                }
                if (truncated) break;
                foreach (var d in dirs)
                {
                    if (SkipDirs.Contains(d.Name) || (d.Attributes & (FileAttributes.System | FileAttributes.ReparsePoint)) != 0) continue;
                    if (Guard.Reason(Rel(root, d.FullName), true, prot) != null) continue;
                    stack.Push(d);
                }
            }
            var top = hits.OrderByDescending(h => h.Key).ThenBy(h => h.Value.FullName.Length).Take(60)
                .Select(h => (object)J.Make("name", h.Value.Name, "path", Rel(root, h.Value.FullName), "size", h.Value.Length)).ToList();
            return J.Make("results", top, "truncated", truncated);
        }

        static bool Subsequence(string needle, string hay)
        {
            int i = 0;
            foreach (char c in hay) if (i < needle.Length && c == needle[i]) i++;
            return i == needle.Length;
        }

        // ---------------------------------------------------------------- read / save

        public static object Read(string projectId, string rel)
        {
            string root = Root(projectId);
            string full = Resolve(root, rel);
            if (!File.Exists(full)) throw new ApiException(404, "File not found: " + rel);
            var fi = new FileInfo(full);
            Guard.Require(Rel(root, full), false, Store.Protected(projectId), "open");
            Guard.RequireOrdinary(fi, "open");
            var result = J.Make("path", Rel(root, full), "name", fi.Name, "size", fi.Length, "modified", fi.LastWriteTimeUtc.Ticks.ToString());

            byte[] bytes;
            bool truncated = fi.Length > MaxReadBytes;
            using (var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                int n = (int)Math.Min(fi.Length, MaxReadBytes);
                bytes = new byte[n];
                int off = 0;
                while (off < n) { int r = fs.Read(bytes, off, n - off); if (r <= 0) break; off += r; }
            }

            bool utf16 = bytes.Length >= 2 && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF));
            if (!utf16)
            {
                int probe = Math.Min(bytes.Length, 8000);
                for (int i = 0; i < probe; i++)
                    if (bytes[i] == 0) { result["binary"] = true; return result; }
            }

            string text;
            using (var sr = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false), true))
                text = sr.ReadToEnd();
            bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
            bool crlf = text.Contains("\r\n");
            result["content"] = text.Replace("\r\n", "\n");
            result["eol"] = crlf ? "crlf" : "lf";
            result["bom"] = bom;
            result["readonly"] = utf16 || truncated || fi.IsReadOnly;
            result["truncated"] = truncated;
            return result;
        }

        public static object Write(string projectId, string rel, string content, string eol, bool bom, string expectedModified)
        {
            string root = Root(projectId);
            string full = Resolve(root, rel);
            if (Directory.Exists(full)) throw new ApiException(400, "That path is a folder.");
            if (!File.Exists(full)) throw new ApiException(404, "File not found: " + rel);
            var before = new FileInfo(full);
            Guard.Require(Rel(root, full), false, Store.Protected(projectId), "change");
            Guard.RequireOrdinary(before, "change");
            if (before.IsReadOnly) throw new ApiException(403, "That file is read-only.");
            if (!string.IsNullOrEmpty(expectedModified) && before.LastWriteTimeUtc.Ticks.ToString() != expectedModified)
                throw new ApiException(409, "This file changed on disk after you opened it. Reload it before saving.");
            string text = (content ?? "").Replace("\r\n", "\n");
            if (eol == "crlf") text = text.Replace("\n", "\r\n");
            File.WriteAllText(full, text, new UTF8Encoding(bom));
            var fi = new FileInfo(full);
            return J.Make("ok", true, "size", fi.Length, "modified", fi.LastWriteTimeUtc.Ticks.ToString());
        }

        // ---------------------------------------------------------------- create / move / delete

        public static object Create(string projectId, string parentRel, string name, bool folder, string content = "")
        {
            if (content != null && content.Length > MaxReadBytes) throw new ApiException(413, "That is too much text for one new file.");
            string root = Root(projectId);
            var prot = Store.Protected(projectId);
            name = Guard.CleanName(name);
            string parent = Resolve(root, parentRel);
            if (!Directory.Exists(parent)) throw new ApiException(404, "The destination folder no longer exists.");
            string parentR = Rel(root, parent);
            if (parentR != "") Guard.Require(parentR, true, prot, "add anything to");
            string full = Resolve(root, (parentR == "" ? "" : parentR + "/") + name);
            string rel = Rel(root, full);
            Guard.Require(rel, folder, prot, "create");
            if (File.Exists(full) || Directory.Exists(full)) throw new ApiException(409, "\"" + name + "\" already exists there.");
            try
            {
                if (folder) Directory.CreateDirectory(full);
                else
                    using (var fs = new FileStream(full, FileMode.CreateNew, FileAccess.Write))   // CreateNew can never overwrite
                    {
                        byte[] bytes = new UTF8Encoding(false).GetBytes(content ?? "");
                        fs.Write(bytes, 0, bytes.Length);
                    }
            }
            catch (UnauthorizedAccessException) { throw new ApiException(403, "Windows denied permission to create that."); }
            catch (IOException ex) { throw new ApiException(409, ex.Message); }
            return J.Make("ok", true, "path", rel, "dir", folder);
        }

        /// <summary>Rename and/or move within the project. Never overwrites an existing item.</summary>
        public static object Move(string projectId, string fromRel, string toParentRel, string newName)
        {
            string root = Root(projectId);
            var prot = Store.Protected(projectId);
            string from = Resolve(root, fromRel);
            if (from.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new ApiException(400, "The project folder itself cannot be moved from here.");
            bool isDir = Directory.Exists(from);
            if (!isDir && !File.Exists(from)) throw new ApiException(404, "\"" + fromRel + "\" no longer exists.");
            string fromR = Rel(root, from);
            FileSystemInfo info = isDir ? (FileSystemInfo)new DirectoryInfo(from) : new FileInfo(from);
            Guard.Require(fromR, isDir, prot, "move");
            Guard.RequireOrdinary(info, "move");
            if (isDir)
            {
                string inside = Guard.FirstLockedInside(root, (DirectoryInfo)info, prot);
                if (inside != null) throw new ApiException(403, "Hearth will not move \"" + fromR + "\" because it contains a protected item: " + inside + ".");
            }

            string toParent = toParentRel == null ? Path.GetDirectoryName(from) : Resolve(root, toParentRel);
            if (!Directory.Exists(toParent)) throw new ApiException(404, "The destination folder no longer exists.");
            string toParentR = Rel(root, toParent);
            if (toParentR != "") Guard.Require(toParentR, true, prot, "move anything into");
            if (isDir && (toParent.Equals(from, StringComparison.OrdinalIgnoreCase) ||
                          toParent.StartsWith(from + "\\", StringComparison.OrdinalIgnoreCase)))
                throw new ApiException(400, "A folder cannot be moved into itself.");

            string name = string.IsNullOrWhiteSpace(newName) ? info.Name : Guard.CleanName(newName);
            string to = Resolve(root, (toParentR == "" ? "" : toParentR + "/") + name);
            string toR = Rel(root, to);
            Guard.Require(toR, isDir, prot, "create");
            if (to.Equals(from, StringComparison.Ordinal)) return J.Make("ok", true, "path", toR, "dir", isDir);
            bool caseOnly = to.Equals(from, StringComparison.OrdinalIgnoreCase);
            if (!caseOnly && (File.Exists(to) || Directory.Exists(to)))
                throw new ApiException(409, "\"" + name + "\" already exists in that folder. Nothing was overwritten.");
            try
            {
                if (isDir) Directory.Move(from, to);
                else File.Move(from, to);
            }
            catch (UnauthorizedAccessException) { throw new ApiException(403, "Windows denied permission to move that."); }
            catch (IOException ex) { throw new ApiException(409, "Could not move it: " + ex.Message); }
            return J.Make("ok", true, "path", toR, "dir", isDir);
        }

        /// <summary>Sends a file or folder to the Recycle Bin. Hearth never deletes permanently.</summary>
        public static object Delete(string projectId, string rel)
        {
            string root = Root(projectId);
            var prot = Store.Protected(projectId);
            string full = Resolve(root, rel);
            if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new ApiException(400, "The project folder itself cannot be deleted from here.");
            bool isDir = Directory.Exists(full);
            if (!isDir && !File.Exists(full)) throw new ApiException(404, "\"" + rel + "\" no longer exists.");
            string r = Rel(root, full);
            FileSystemInfo info = isDir ? (FileSystemInfo)new DirectoryInfo(full) : new FileInfo(full);
            Guard.Require(r, isDir, prot, "delete");
            Guard.RequireOrdinary(info, "delete");
            if (isDir)
            {
                string inside = Guard.FirstLockedInside(root, (DirectoryInfo)info, prot);
                if (inside != null) throw new ApiException(403, "Hearth will not delete \"" + r + "\" because it contains a protected item: " + inside + ".");
            }

            Exception error = null;
            var t = new Thread(() =>
            {
                try
                {
                    if (isDir) FileSystem.DeleteDirectory(full, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin, UICancelOption.ThrowException);
                    else FileSystem.DeleteFile(full, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin, UICancelOption.ThrowException);
                }
                catch (Exception ex) { error = ex; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            t.Join();
            if (error != null) throw new ApiException(500, "Could not move it to the Recycle Bin: " + error.Message);
            if (File.Exists(full) || Directory.Exists(full)) throw new ApiException(500, "Windows did not remove \"" + r + "\".");
            return J.Make("ok", true, "recycled", true);
        }

        /// <summary>Lets the user lock (or unlock) their own files and folders.</summary>
        public static object SetProtected(string projectId, string rel, bool on)
        {
            string root = Root(projectId);
            string full = Resolve(root, rel);
            string r = Rel(root, full);
            if (r == "") throw new ApiException(400, "Pick a file or folder inside the project.");
            if (on && !File.Exists(full) && !Directory.Exists(full)) throw new ApiException(404, "\"" + rel + "\" no longer exists.");
            return J.Make("ok", true, "protected", Store.SetProtected(projectId, r, on));
        }
    }
}
