using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Hearth
{
    /// <summary>
    /// Online model catalogs (ollama.com and Hugging Face). This is metadata browsing only: no prompts,
    /// files or chat content are ever sent here, and nothing in this class performs inference.
    /// What is returned is filtered by <see cref="Sources"/> (security level) and cloud-hosted variants
    /// are always removed, so only models that run on this PC and pass the policy are offered.
    /// </summary>
    static class Catalog
    {
        static readonly HashSet<string> Capabilities = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "tools", "vision", "thinking", "embedding", "audio", "decision", "cloud" };

        public static string Fetch(string url, string accept = "text/html", int timeoutMs = 20000, bool fragment = false)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.UserAgent = "Hearth/1.0 (desktop model browser)";
            req.Accept = accept;
            if (fragment) req.Headers["HX-Request"] = "true";   // ollama.com serves later result pages only to this kind of request
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    return r.ReadToEnd();
            }
            catch (WebException ex)
            {
                var resp = ex.Response as HttpWebResponse;
                if (resp != null && resp.StatusCode == HttpStatusCode.NotFound) throw new ApiException(404, "Not found in the online catalog.");
                if (resp != null && (resp.StatusCode == HttpStatusCode.Unauthorized || resp.StatusCode == HttpStatusCode.Forbidden))
                    throw new ApiException(403, "The online catalog refused access to that item.");
                throw new ApiException(502, "Could not reach the online catalog. Check your internet connection.");
            }
        }

        static string Clean(string html)
        {
            if (html == null) return "";
            string t = Regex.Replace(html, "<[^>]+>", " ");
            t = WebUtility.HtmlDecode(t);
            return Regex.Replace(t, @"\s+", " ").Trim();
        }

        // ---------------------------------------------------------------- ollama.com

        public static object SearchOllama(string q, string caps, string size, string sort, string page)
        {
            string level = Sources.Level();
            int pageNo;
            if (!int.TryParse(page, out pageNo) || pageNo < 1 || pageNo > 50) pageNo = 1;

            var url = new StringBuilder("https://ollama.com/search?c=local");
            if (!string.IsNullOrWhiteSpace(q)) url.Append("&q=").Append(Uri.EscapeDataString(q.Trim()));
            foreach (string c in (caps ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                if (Capabilities.Contains(c) && !c.Equals("cloud", StringComparison.OrdinalIgnoreCase))
                    url.Append("&c=").Append(c.ToLowerInvariant());
            if (!string.IsNullOrEmpty(size) && Regex.IsMatch(size, @"^(8|16|32|64|over64)$")) url.Append("&s=").Append(size);
            if (!string.IsNullOrEmpty(sort) && Regex.IsMatch(sort, @"^(popular|newest|name)$")) url.Append("&o=").Append(sort);
            var results = new List<object>();
            var seen = new HashSet<string>();
            int hiddenCommunity = 0, fetched = 0;
            bool more;
            // Later pages can consist entirely of uploads hidden at this security level, so keep going
            // (a few pages at most) until there is something to show.
            while (true)
            {
            string html = Fetch(url + (pageNo > 1 ? "&page=" + pageNo : ""), "text/html", 20000, true);
            int found = 0;
            foreach (Match m in Regex.Matches(html, @"<a href=""/([\w.\-]+)/([\w.\-]+)""\s+class=""group[\s\S]*?</a>"))
            {
                string owner = m.Groups[1].Value, model = m.Groups[2].Value;
                bool official = owner == "library";
                string name = official ? model : owner + "/" + model;
                if (!seen.Add(name)) continue;
                found++;
                string block = m.Value;

                var caplist = new List<object>();
                var sizes = new List<object>();
                bool cloudOnly = false;
                foreach (Match b in Regex.Matches(block, @"<span[^>]*rounded-md[^>]*>\s*([^<]{1,24}?)\s*</span>"))
                {
                    string label = WebUtility.HtmlDecode(b.Groups[1].Value).Trim();
                    if (label == "") continue;
                    if (label.Equals("cloud", StringComparison.OrdinalIgnoreCase)) { cloudOnly = true; continue; }
                    if (Capabilities.Contains(label)) caplist.Add(label.ToLowerInvariant());
                    else sizes.Add(label);
                }
                // "cloud" badge with no downloadable sizes means there is nothing to run locally.
                if (cloudOnly && sizes.Count == 0) continue;

                string kind = official ? Sources.Official : Sources.Community;
                if (!Sources.Allowed(kind, level)) { hiddenCommunity++; continue; }

                Match desc = Regex.Match(block, @"<p[^>]*>([\s\S]*?)</p>");
                Match pulls = Regex.Match(block, @"title=""([\d,]+) downloads""");
                Match updated = Regex.Match(block, @"title=""Updated ([^""]+)""");
                results.Add(J.Make(
                    "name", name,
                    "source", kind,
                    "publisher", official ? "Ollama" : owner,
                    "description", desc.Success ? Clean(desc.Groups[1].Value) : "",
                    "pulls", pulls.Success ? long.Parse(pulls.Groups[1].Value.Replace(",", "")) : 0,
                    "updated", updated.Success ? updated.Groups[1].Value : "",
                    "capabilities", caplist,
                    "sizes", sizes,
                    "url", "https://ollama.com/" + owner + "/" + model));
            }
            more = found >= 20 && html.Contains("page=" + (pageNo + 1));
            fetched++;
            if (!more || results.Count >= 10 || fetched >= 4) break;
            pageNo++;
            }
            return J.Make("results", results, "page", pageNo, "more", more, "hidden", hiddenCommunity, "level", level);
        }

        public static object OllamaTags(string name)
        {
            if (string.IsNullOrEmpty(name) || !Regex.IsMatch(name, @"^[\w.\-]+(/[\w.\-]+)?$")) throw new ApiException(400, "Invalid model name.");
            string publisher;
            string kind = Sources.Classify(name, out publisher);
            if (!Sources.Allowed(kind, Sources.Level()))
                throw new ApiException(403, "Community uploads are hidden at your current model security level.");

            string path = name.Contains("/") ? name : "library/" + name;
            string html = Fetch("https://ollama.com/" + path + "/tags");

            var tags = new List<object>();
            var seen = new HashSet<string>();
            int hiddenCloud = 0;
            var rx = new Regex(@"<a href=""/" + Regex.Escape(path) + @":([^""]+)""\s+class=""md:hidden[\s\S]*?<span class=""font-mono"">\s*([0-9a-f]+)\s*</span>([^<]*)<[\s\S]*?</a>");
            foreach (Match m in rx.Matches(html))
            {
                string tag = WebUtility.HtmlDecode(m.Groups[1].Value);
                if (!seen.Add(tag)) continue;
                string[] parts = WebUtility.HtmlDecode(m.Groups[3].Value).Split('•').Select(x => x.Trim()).Where(x => x != "").ToArray();
                string size = parts.Length > 0 ? parts[0] : "";
                string ctx = parts.Length > 1 ? parts[1].Replace("context window", "").Trim() : "";
                bool hasSize = Regex.IsMatch(size, @"^\d+(\.\d+)?\s*[KMGT]B(\s*-\s*\d+(\.\d+)?\s*[KMGT]B)?$", RegexOptions.IgnoreCase);
                if (Ollama.IsCloudName(tag) || !hasSize) { hiddenCloud++; continue; }
                Match input = Regex.Match(m.Value, @"([A-Z][A-Za-z, ]*?) input");
                tags.Add(J.Make(
                    "tag", tag,
                    "name", name + ":" + tag,
                    "size", size,
                    "bytes", ParseSize(size),
                    "context", ctx,
                    "input", input.Success ? input.Groups[1].Value.Trim() : "",
                    "digest", m.Groups[2].Value));
            }
            return J.Make("name", name, "tags", tags, "hiddenCloud", hiddenCloud, "source", kind);
        }

        static long ParseSize(string s)
        {
            Match m = Regex.Match(s ?? "", @"(\d+(?:\.\d+)?)\s*([KMGT])B$", RegexOptions.IgnoreCase);   // for a range, the larger end
            if (!m.Success) return 0;
            double v = double.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            switch (char.ToUpperInvariant(m.Groups[2].Value[0]))
            {
                case 'K': return (long)(v * 1e3);
                case 'M': return (long)(v * 1e6);
                case 'G': return (long)(v * 1e9);
                default: return (long)(v * 1e12);
            }
        }

        // ---------------------------------------------------------------- Hugging Face (GGUF)

        public static object SearchHuggingFace(string q, string sort)
        {
            string level = Sources.Level();
            if (level == "official")
                return J.Make("results", new List<object>(), "hidden", 0, "level", level, "disabled", true);

            string order = sort == "likes" ? "likes" : sort == "recent" ? "lastModified" : "downloads";
            string url = "https://huggingface.co/api/models?filter=gguf&sort=" + order + "&direction=-1&limit=100";
            if (!string.IsNullOrWhiteSpace(q)) url += "&search=" + Uri.EscapeDataString(q.Trim());

            var raw = new List<Dictionary<string, object>>();
            foreach (object o in J.Arr(J.Parse(Fetch(url, "application/json"))))
            {
                var d = J.Obj(o);
                string id = J.S(d, "id");
                if (string.IsNullOrEmpty(id) || !Regex.IsMatch(id, @"^[\w.\-]+/[\w.\-]+$")) continue;
                object priv = J.Get(d, "private"), gated = J.Get(d, "gated");
                if (priv is bool && (bool)priv) continue;
                if (gated != null && !(gated is bool && !(bool)gated)) continue;
                raw.Add(d);
            }

            // Look up which publishers are verified organisations (cached; a handful of quick parallel requests).
            var authors = raw.Select(d => J.S(d, "id").Split('/')[0]).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            Parallel.ForEach(authors, new ParallelOptions { MaxDegreeOfParallelism = 12 }, a => Sources.IsTrustedPublisher(a, true));

            var results = new List<object>();
            int hidden = 0;
            foreach (var d in raw)
            {
                string id = J.S(d, "id");
                string author = id.Split('/')[0];
                bool trusted = Sources.IsTrustedPublisher(author, false);
                string kind = trusted ? Sources.HfTrusted : Sources.HfOther;
                if (!Sources.Allowed(kind, level)) { hidden++; continue; }
                string license = "", baseModel = "";
                foreach (object t in J.Arr(J.Get(d, "tags")))
                {
                    string tag = t as string ?? "";
                    if (tag.StartsWith("license:")) license = tag.Substring(8);
                    else if (tag.StartsWith("base_model:") && !tag.StartsWith("base_model:quantized:") && baseModel == "") baseModel = tag.Substring(11);
                }
                results.Add(J.Make(
                    "id", id,
                    "source", kind,
                    "publisher", author,
                    "downloads", J.L(d, "downloads"),
                    "likes", J.L(d, "likes"),
                    "task", J.S(d, "pipeline_tag", ""),
                    "license", license,
                    "baseModel", baseModel,
                    "created", J.S(d, "createdAt", ""),
                    "url", "https://huggingface.co/" + id));
            }
            return J.Make("results", results, "hidden", hidden, "level", level);
        }

        public static object HuggingFaceFiles(string id)
        {
            if (string.IsNullOrEmpty(id) || !Regex.IsMatch(id, @"^[\w.\-]+/[\w.\-]+$")) throw new ApiException(400, "Invalid repository id.");
            string level = Sources.Level();
            string publisher;
            string kind = Sources.Classify("hf.co/" + id, out publisher);
            if (!Sources.Allowed(kind, level)) throw new ApiException(403, "This publisher is hidden at your current model security level.");

            var d = Sources.HuggingFaceInfo(id);
            string blocked = Sources.HuggingFaceBlockReason(d, level);
            if (blocked != null) return J.Make("id", id, "tags", new List<object>(), "blocked", blocked, "source", kind);

            var best = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, object> plain = null;
            int plainCount = 0;
            var rx = new Regex(@"(?:^|[-._/])((?:UD-)?I?Q\d+(?:_[A-Za-z0-9]+)*|BF16|F16|F32)\.gguf$", RegexOptions.IgnoreCase);
            foreach (object o in J.Arr(J.Get(d, "siblings")))
            {
                var f = J.Obj(o);
                string file = J.S(f, "rfilename", "");
                if (!file.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase)) continue;
                if (file.IndexOf("mmproj", StringComparison.OrdinalIgnoreCase) >= 0 || file.Contains("/")) continue;
                if (Regex.IsMatch(file, @"-\d{5}-of-\d{5}\.gguf$")) continue;   // split files are not pullable as one tag
                long bytes = J.L(f, "size");
                Match m = rx.Match(file);
                if (!m.Success)
                {
                    // No quantisation label in the file name: only usable when it is the repository's single build.
                    plainCount++;
                    plain = J.Make("tag", "default", "name", "hf.co/" + id, "file", file, "bytes", bytes);
                    continue;
                }
                string quant = m.Groups[1].Value.ToUpperInvariant();
                if (quant.StartsWith("UD-")) quant = quant.Substring(3);
                if (best.ContainsKey(quant)) continue;
                best[quant] = J.Make("tag", quant, "name", "hf.co/" + id + ":" + quant, "file", file, "bytes", bytes);
            }
            var tags = best.Values.OrderBy(x => J.L(x, "bytes")).Cast<object>().ToList();
            if (tags.Count == 0 && plainCount == 1 && plain != null) tags.Add(plain);
            var sec = J.Obj(J.Get(d, "securityRepoStatus"));
            object done = sec == null ? null : J.Get(sec, "scansDone");
            return J.Make("id", id, "tags", tags, "source", kind, "scanned", done is bool && (bool)done);
        }
    }
}
