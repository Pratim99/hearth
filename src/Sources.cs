using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Hearth
{
    /// <summary>
    /// MODEL SOURCE POLICY. Decides which models may appear in the catalog and which may be downloaded.
    /// It is applied here, in the backend, both when listing and again at download time, so a model that
    /// is hidden at the current security level cannot be fetched by typing its name either.
    ///
    ///   Level "official" : only the official Ollama library.
    ///   Level "trusted"  : official library + Hugging Face repositories from verified organisations
    ///                      and well-known publishers.                                   (default)
    ///   Level "all"      : also community uploads on ollama.com and other Hugging Face publishers,
    ///                      always labelled as unreviewed.
    ///
    /// At every level: cloud-hosted models, registries other than Ollama and Hugging Face, private or
    /// gated repositories, and repositories Hugging Face's own security scan has flagged are refused.
    /// </summary>
    static class Sources
    {
        public const string Official = "official", Community = "community", HfTrusted = "hf-trusted", HfOther = "hf-other";

        /// <summary>Long-standing publishers of GGUF builds that are individuals or unverified groups on Hugging Face.</summary>
        static readonly HashSet<string> KnownPublishers = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "bartowski", "unsloth", "lmstudio-community", "TheBloke", "mradermacher", "MaziyarPanahi",
            "QuantFactory", "ggml-org", "second-state", "NousResearch"
        };

        static readonly Dictionary<string, bool> VerifiedCache = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        static readonly object CacheLock = new object();

        public static string Level()
        {
            string l = J.S(Store.Settings(), "sourceLevel", "trusted");
            return l == "official" || l == "all" ? l : "trusted";
        }

        public static string NormalizeLevel(object value)
        {
            string l = value as string;
            if (l != "official" && l != "trusted" && l != "all") throw new ApiException(400, "Unknown security level.");
            return l;
        }

        // ---------------------------------------------------------------- Hugging Face trust

        /// <summary>True for well-known publishers and for organisations Hugging Face has verified.</summary>
        public static bool IsTrustedPublisher(string author, bool allowLookup)
        {
            if (string.IsNullOrEmpty(author)) return false;
            if (KnownPublishers.Contains(author)) return true;
            lock (CacheLock) { bool v; if (VerifiedCache.TryGetValue(author, out v)) return v; }
            if (!allowLookup) return false;
            bool verified = false;
            try
            {
                var d = J.ParseObj(Catalog.Fetch("https://huggingface.co/api/organizations/" + Uri.EscapeDataString(author) + "/overview", "application/json", 6000));
                object flag = J.Get(d, "isVerified");
                verified = flag is bool && (bool)flag;
            }
            catch { verified = false; }     // not an organisation, or unreachable: not trusted
            lock (CacheLock) { VerifiedCache[author] = verified; }
            return verified;
        }

        /// <summary>
        /// Checks a Hugging Face repository before anything is offered or downloaded from it.
        /// Returns null when it is acceptable, otherwise the reason it is blocked.
        /// </summary>
        public static string HuggingFaceBlockReason(Dictionary<string, object> info, string level)
        {
            object priv = J.Get(info, "private"), disabled = J.Get(info, "disabled"), gated = J.Get(info, "gated");
            if (priv is bool && (bool)priv) return "This repository is private.";
            if (disabled is bool && (bool)disabled) return "Hugging Face has disabled this repository.";
            if (gated != null && !(gated is bool && !(bool)gated)) return "This repository is gated: it needs a Hugging Face account and the publisher's approval, which Hearth does not use.";

            var sec = J.Obj(J.Get(info, "securityRepoStatus"));
            int issues = sec == null ? 0 : J.Arr(J.Get(sec, "filesWithIssues")).Count();
            if (issues > 0) return "Hugging Face's security scan flagged " + issues + " file" + (issues == 1 ? "" : "s") + " in this repository.";
            object done = sec == null ? null : J.Get(sec, "scansDone");
            bool scanned = done is bool && (bool)done;
            if (!scanned && level != "all") return "Hugging Face has not finished its security scan of this repository yet.";
            return null;
        }

        public static Dictionary<string, object> HuggingFaceInfo(string id)
        {
            return J.ParseObj(Catalog.Fetch("https://huggingface.co/api/models/" + id + "?blobs=true&securityStatus=true", "application/json"));
        }

        // ---------------------------------------------------------------- classification

        /// <summary>Works out where a model name would be downloaded from. Throws for anything Hearth never fetches.</summary>
        public static string Classify(string name, out string publisher)
        {
            publisher = "";
            string bare = name.Trim();
            int colon = bare.LastIndexOf(':');
            if (colon > bare.LastIndexOf('/')) bare = bare.Substring(0, colon);
            string[] seg = bare.Split('/');
            if (seg.Length == 3)
            {
                string host = seg[0].ToLowerInvariant();
                if (host == "hf.co" || host == "huggingface.co")
                {
                    publisher = seg[1];
                    return IsTrustedPublisher(seg[1], true) ? HfTrusted : HfOther;
                }
                if (host == "registry.ollama.ai" || host == "ollama.com")
                {
                    if (seg[1] == "library") return Official;
                    publisher = seg[1];
                    return Community;
                }
                throw new ApiException(403, "Hearth only downloads models from the Ollama library and Hugging Face, not from \"" + seg[0] + "\".");
            }
            if (seg.Length == 2)
            {
                if (seg[0] == "library") return Official;
                publisher = seg[0];
                return Community;
            }
            if (seg.Length == 1) return Official;
            throw new ApiException(400, "That does not look like a valid model name.");
        }

        public static bool Allowed(string kind, string level)
        {
            if (kind == Official) return true;
            if (kind == HfTrusted) return level != "official";
            return level == "all";
        }

        static string LevelName(string level)
        {
            return level == "official" ? "Official only" : level == "trusted" ? "Trusted publishers" : "Everything";
        }

        /// <summary>The gate every download passes through.</summary>
        public static void RequireDownloadAllowed(string name)
        {
            Ollama.RequireLocalPull(name);
            string level = Level();
            string publisher;
            string kind = Classify(name, out publisher);
            if (!Allowed(kind, level))
            {
                string what = kind == Community ? "a community upload by \"" + publisher + "\" that Ollama has not reviewed"
                    : kind == HfOther ? "from \"" + publisher + "\", a Hugging Face publisher that is not verified"
                    : "from Hugging Face";
                throw new ApiException(403, "\"" + name + "\" is " + what + ". Your model security level (" + LevelName(level) +
                    ") does not allow it. You can change the level on the Models screen.");
            }
            if (kind == HfTrusted || kind == HfOther)
            {
                string bare = name.Trim();
                int colon = bare.LastIndexOf(':');
                if (colon > bare.LastIndexOf('/')) bare = bare.Substring(0, colon);
                string[] seg = bare.Split('/');
                string reason = HuggingFaceBlockReason(HuggingFaceInfo(seg[1] + "/" + seg[2]), level);
                if (reason != null) throw new ApiException(403, "Download blocked: " + reason);
            }
        }

        /// <summary>Where an already-installed model came from, for display.</summary>
        public static string InstalledSource(string name)
        {
            try
            {
                string bare = name;
                int colon = bare.LastIndexOf(':');
                if (colon > bare.LastIndexOf('/')) bare = bare.Substring(0, colon);
                string[] seg = bare.Split('/');
                if (seg.Length == 1 || (seg.Length == 2 && seg[0] == "library")) return Official;
                if (seg.Length == 2) return Community;
                string host = seg[0].ToLowerInvariant();
                if (host == "hf.co" || host == "huggingface.co") return IsTrustedPublisher(seg[1], false) ? HfTrusted : HfOther;
                if (host == "registry.ollama.ai" || host == "ollama.com") return seg[1] == "library" ? Official : Community;
            }
            catch { }
            return "other";
        }
    }
}
