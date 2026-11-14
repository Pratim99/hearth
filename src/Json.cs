using System;
using System.Collections;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Hearth
{
    /// <summary>Thin helpers over the JSON serializer built into .NET Framework.</summary>
    static class J
    {
        static JavaScriptSerializer New()
        {
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };
        }

        public static object Parse(string s) { return New().DeserializeObject(s); }
        public static string Str(object o) { return New().Serialize(o); }

        public static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }

        public static Dictionary<string, object> ParseObj(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return new Dictionary<string, object>();
            var d = Parse(s) as Dictionary<string, object>;
            if (d == null) throw new ApiException(400, "Expected a JSON object.");
            return d;
        }

        public static IEnumerable<object> Arr(object o)
        {
            var list = o as IEnumerable;
            if (list == null || o is string) yield break;
            foreach (object x in list) yield return x;
        }

        public static object Get(Dictionary<string, object> d, string k)
        {
            object v;
            if (d != null && d.TryGetValue(k, out v)) return v;
            return null;
        }

        public static string S(Dictionary<string, object> d, string k, string def = null)
        {
            object v = Get(d, k);
            if (v == null) return def;
            return v as string ?? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }

        public static long L(Dictionary<string, object> d, string k, long def = 0)
        {
            object v = Get(d, k);
            if (v == null) return def;
            try { return Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture); }
            catch { return def; }
        }

        public static Dictionary<string, object> Make(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }
    }

    class ApiException : Exception
    {
        public int Status;
        public ApiException(int status, string message) : base(message) { Status = status; }
    }
}
