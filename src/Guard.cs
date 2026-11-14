using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>
    /// FILE GUARDRAILS. Every file operation in Hearth is checked here, on the backend, so the
    /// interface (or anything driving it) cannot get around them.
    ///
    ///   1. Nothing outside the project's linked folder can be touched, and system locations,
    ///      whole drives and the user-profile root cannot be linked as a project at all.
    ///   2. Sensitive folders (.git, .ssh, cloud credentials...) and credential-style files
    ///      (.env, private keys, token stores...) are locked: not opened, changed, moved or deleted.
    ///   3. Anything the user marks as protected is locked the same way.
    ///   4. A folder that contains locked items cannot be moved or deleted as a whole.
    ///   5. Links/junctions and Windows system files are never operated on.
    /// </summary>
    static class Guard
    {
        static readonly HashSet<string> LockedFolders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".gcloud", ".password-store",
            "$RECYCLE.BIN", "System Volume Information"
        };

        static readonly HashSet<string> SecretNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".htpasswd", ".pgpass",
            "credentials", "credentials.json", "credentials.yml", "credentials.yaml", "token.json",
            "wallet.dat", "secrets.json", "secrets.yml", "secrets.yaml", "secrets.toml", "known_hosts",
            "authorized_keys", "ntuser.dat"
        };

        static readonly HashSet<string> SecretExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".pem", ".key", ".pfx", ".p12", ".ppk", ".kdbx", ".keystore", ".jks", ".ovpn", ".gpg", ".asc"
        };

        static readonly Regex SecretPattern = new Regex(
            @"^(id_(rsa|dsa|ecdsa|ed25519)(\..+)?|\.env(\..+)?|service[-_]?account.*\.json|.*\.secret(s)?(\..+)?)$",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        static readonly Regex EnvTemplate = new Regex(@"^\.env\.(example|sample|template|dist)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        static readonly Regex ReservedName = new Regex(@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static bool IsSecretFileName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (EnvTemplate.IsMatch(name)) return false;
            if (SecretNames.Contains(name)) return true;
            if (name.EndsWith(".pub", StringComparison.OrdinalIgnoreCase)) return false;   // public keys are not secrets
            if (SecretExtensions.Contains(Path.GetExtension(name))) return true;
            return SecretPattern.IsMatch(name);
        }

        /// <summary>
        /// The same sensitive names expressed as Git ignore patterns, so uploads leave them out.
        /// <see cref="Reason"/> remains the authority: uploads are re-checked against it afterwards.
        /// </summary>
        public static IEnumerable<string> IgnorePatterns()
        {
            foreach (string f in LockedFolders)
                if (f != ".git" && !f.StartsWith("$") && !f.Contains(" ")) yield return f + "/";
            yield return ".env";
            yield return ".env.*";
            foreach (string t in new[] { "example", "sample", "template", "dist" }) yield return "!.env." + t;
            foreach (string n in SecretNames) yield return n;
            foreach (string e in SecretExtensions) yield return "*" + e;
            foreach (string k in new[] { "rsa", "dsa", "ecdsa", "ed25519" }) yield return "id_" + k + "*";
            yield return "!id_*.pub";
            foreach (string s in new[] { "service-account*.json", "service_account*.json", "serviceaccount*.json", "*.secret", "*.secrets", "*.secret.*", "*.secrets.*" })
                yield return s;
        }

        /// <summary>
        /// Why a project-relative path is locked, or null if it is free to work with.
        /// <paramref name="rel"/> uses forward slashes.
        /// </summary>
        public static string Reason(string rel, bool isDir, ICollection<string> userProtected)
        {
            if (string.IsNullOrEmpty(rel)) return null;
            string[] segs = rel.Split('/');
            for (int i = 0; i < segs.Length; i++)
            {
                bool segIsDir = i < segs.Length - 1 || isDir;
                if (segIsDir && LockedFolders.Contains(segs[i]))
                    return i == segs.Length - 1
                        ? "\"" + segs[i] + "\" is a protected system folder"
                        : "it is inside the protected folder \"" + segs[i] + "\"";
            }
            if (!isDir && IsSecretFileName(segs[segs.Length - 1])) return "it looks like a credentials or key file";
            if (userProtected != null)
                foreach (string u in userProtected)
                {
                    if (string.IsNullOrEmpty(u)) continue;
                    if (rel.Equals(u, StringComparison.OrdinalIgnoreCase)) return "you marked it as protected";
                    if (rel.StartsWith(u + "/", StringComparison.OrdinalIgnoreCase)) return "it is inside \"" + u + "\", which you marked as protected";
                }
            return null;
        }

        public static void Require(string rel, bool isDir, ICollection<string> userProtected, string verb)
        {
            string why = Reason(rel, isDir, userProtected);
            if (why != null) throw new ApiException(403, "Hearth will not " + verb + " \"" + rel + "\" because " + why + ".");
        }

        /// <summary>Refuses links/junctions and Windows system items, which could lead outside the project.</summary>
        public static void RequireOrdinary(FileSystemInfo info, string verb)
        {
            if (!info.Exists) return;
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new ApiException(403, "Hearth will not " + verb + " \"" + info.Name + "\" because it is a link to another location.");
            if ((info.Attributes & FileAttributes.System) != 0)
                throw new ApiException(403, "Hearth will not " + verb + " \"" + info.Name + "\" because Windows marks it as a system item.");
        }

        /// <summary>Finds the first locked thing inside a folder (so the folder cannot be moved/deleted wholesale).</summary>
        public static string FirstLockedInside(string root, DirectoryInfo dir, ICollection<string> userProtected)
        {
            var stack = new Stack<DirectoryInfo>();
            stack.Push(dir);
            while (stack.Count > 0)
            {
                var d = stack.Pop();
                FileSystemInfo[] items;
                try { items = d.GetFileSystemInfos(); }
                catch { return Rel(root, d.FullName) + " (cannot be inspected)"; }
                foreach (var it in items)
                {
                    bool isDir = (it.Attributes & FileAttributes.Directory) != 0;
                    string rel = Rel(root, it.FullName);
                    if ((it.Attributes & FileAttributes.ReparsePoint) != 0) return rel + " (a link to another location)";
                    if ((it.Attributes & FileAttributes.System) != 0) return rel + " (a Windows system item)";
                    if (Reason(rel, isDir, userProtected) != null) return rel;
                    if (isDir) stack.Push((DirectoryInfo)it);
                }
            }
            return null;
        }

        public static string Rel(string root, string full)
        {
            return full.Substring(root.Length).TrimStart('\\').Replace('\\', '/');
        }

        /// <summary>Validates a single new file/folder name typed by the user.</summary>
        public static string CleanName(string name)
        {
            name = (name ?? "").Trim();
            if (name == "" || name == "." || name == "..") throw new ApiException(400, "Enter a name.");
            if (name.Length > 200) throw new ApiException(400, "That name is too long.");
            if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new ApiException(400, "Names cannot contain \\ / : * ? \" < > |");
            if (name.EndsWith(".") || name.EndsWith(" ")) throw new ApiException(400, "Names cannot end with a dot or a space.");
            if (ReservedName.IsMatch(name)) throw new ApiException(400, "\"" + name + "\" is a name reserved by Windows.");
            return name;
        }

        /// <summary>Decides whether a folder is acceptable as a project root.</summary>
        public static void RequireSafeProjectRoot(string full)
        {
            string root = Path.GetPathRoot(full) ?? "";
            if (Same(full, root)) throw new ApiException(400, "Choose a folder inside the drive rather than the whole drive.");

            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string users = string.IsNullOrEmpty(profile) ? null : Path.GetDirectoryName(profile);
            if (Same(full, profile) || Same(full, users))
                throw new ApiException(400, "Your whole user folder is too broad for a project. Choose a folder inside it, such as one under Documents.");

            var blockedTrees = new List<string>
            {
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                Environment.GetEnvironmentVariable("ProgramW6432"),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                string.IsNullOrEmpty(profile) ? null : Path.Combine(profile, "AppData"),
                Store.DataDir
            };
            foreach (string b in blockedTrees)
            {
                if (string.IsNullOrEmpty(b)) continue;
                if (Same(full, b) || full.StartsWith(b.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
                    throw new ApiException(400, "That location holds system or application data, so Hearth will not use it as a project folder.");
            }

            foreach (string seg in full.Split('\\'))
                if (LockedFolders.Contains(seg))
                    throw new ApiException(400, "\"" + seg + "\" is a protected folder and cannot be used as a project.");

            var info = new DirectoryInfo(full);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new ApiException(400, "That folder is a link to another location. Choose the real folder instead.");
        }

        static bool Same(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            return string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
    }
}
