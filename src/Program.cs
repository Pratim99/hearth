using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]
[assembly: AssemblyTitle("Hearth")]
[assembly: AssemblyProduct("Hearth")]
[assembly: AssemblyDescription("Local AI workbench for Ollama")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace Hearth
{
    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            bool noWindow = false, stay = false;
            int port = 47610;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--no-window") noWindow = true;
                else if (args[i] == "--stay") stay = true;
                else if (args[i] == "--port" && i + 1 < args.Length) int.TryParse(args[++i], out port);
            }

            try
            {
                try { SetProcessDPIAware(); } catch { }

                ServicePointManager.DefaultConnectionLimit = 64;
                ServicePointManager.Expect100Continue = false;
                try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288; }
                catch { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; }
                ThreadPool.SetMinThreads(48, 48);

                Store.Init();

                bool created;
                using (var mutex = new Mutex(true, "Local\\Hearth.SingleInstance", out created))
                {
                    if (!created)
                    {
                        // Already running: just open another window onto the live session.
                        string existing = Store.ReadSessionUrl();
                        if (existing != null && Launcher.IsAlive(existing))
                        {
                            if (!noWindow) Launcher.OpenWindow(existing);
                            return 0;
                        }
                    }

                    string appDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
                    if (!File.Exists(Path.Combine(appDir, "index.html")) && typeof(Program).Assembly.GetManifestResourceStream("app/index.html") == null)
                        throw new FileNotFoundException("Hearth's interface files are missing from this build.");

                    var server = new Server(appDir);
                    server.Start(port);
                    Store.WriteSessionUrl(server.LaunchUrl);

                    if (!noWindow) Launcher.OpenWindow(server.LaunchUrl);

                    server.WaitUntilIdle(stay);
                    Store.ClearSessionUrl();
                    server.Stop();
                }
                return 0;
            }
            catch (Exception ex)
            {
                if (!noWindow)
                    MessageBox.Show(ex.Message, "Hearth could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
                else
                    Console.Error.WriteLine(ex);
                return 1;
            }
        }
    }

    /// <summary>Opens the UI as a chromeless app window using the Edge runtime that ships with Windows.</summary>
    static class Launcher
    {
        public static void OpenWindow(string url)
        {
            string edge = FindEdge();
            if (edge == null)
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return;
            }
            string profile = Path.Combine(Store.DataDir, "window-profile");
            Directory.CreateDirectory(profile);
            string a =
                "--app=\"" + url + "\"" +
                " --user-data-dir=\"" + profile + "\"" +
                " --window-size=1480,940" +
                " --no-first-run --no-default-browser-check" +
                " --disable-sync --disable-background-mode --disable-background-networking" +
                " --disable-component-update --disable-domain-reliability --no-pings" +
                // Keep replies streaming at full speed while the window is minimized or covered.
                " --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows" +
                " --disable-features=Translate,msEdgeSidebarV2,EdgeCopilot,msShorelineCopilot,msEdgeShoppingAssistant";
            Process.Start(new ProcessStartInfo(edge, a) { UseShellExecute = false });
        }

        static string FindEdge()
        {
            string[] roots =
            {
                Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
                Environment.GetEnvironmentVariable("ProgramFiles"),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            };
            foreach (string r in roots)
            {
                if (string.IsNullOrEmpty(r)) continue;
                string p = Path.Combine(r, "Microsoft\\Edge\\Application\\msedge.exe");
                if (File.Exists(p)) return p;
            }
            return null;
        }

        public static bool IsAlive(string launchUrl)
        {
            try
            {
                var u = new Uri(launchUrl);
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + u.Port + "/api/ping");
                req.Proxy = null;
                req.Timeout = 1500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                    return resp.StatusCode == HttpStatusCode.OK;
            }
            catch { return false; }
        }
    }
}
