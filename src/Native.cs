using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace Hearth
{
    /// <summary>What this PC has to run models on: used for "will it fit" hints.</summary>
    static class Hardware
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MEMORYSTATUSEX
        {
            public uint dwLength, dwMemoryLoad;
            public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        }

        [DllImport("kernel32.dll")]
        static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);

        static Dictionary<string, object> _cached;

        public static Dictionary<string, object> Info()
        {
            if (_cached != null) return _cached;
            long ram = 0, vram = 0;
            string gpu = "";
            try
            {
                var m = new MEMORYSTATUSEX();
                m.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
                if (GlobalMemoryStatusEx(ref m)) ram = (long)m.ullTotalPhys;
            }
            catch { }
            try
            {
                using (var cls = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"))
                {
                    if (cls != null)
                        foreach (string sub in cls.GetSubKeyNames())
                        {
                            try
                            {
                                using (var k = cls.OpenSubKey(sub))
                                {
                                    if (k == null) continue;
                                    object qw = k.GetValue("HardwareInformation.qwMemorySize");
                                    if (qw == null) continue;
                                    long bytes = Convert.ToInt64(qw);
                                    if (bytes > vram) { vram = bytes; gpu = Convert.ToString(k.GetValue("DriverDesc")); }
                                }
                            }
                            catch { }
                        }
                }
            }
            catch { }
            _cached = J.Make("gpu", gpu, "vram", vram, "ram", ram);
            return _cached;
        }
    }

    /// <summary>Starts the Ollama background app when it is installed but not running.</summary>
    static class OllamaProcess
    {
        public static bool Start()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\Ollama");
            string tray = Path.Combine(dir, "ollama app.exe");
            string cli = Path.Combine(dir, "ollama.exe");
            try
            {
                if (File.Exists(tray))
                {
                    Process.Start(new ProcessStartInfo(tray) { UseShellExecute = false, WorkingDirectory = dir });
                    return true;
                }
                if (File.Exists(cli))
                {
                    Process.Start(new ProcessStartInfo(cli, "serve") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = dir });
                    return true;
                }
            }
            catch { }
            return false;
        }
    }

    /// <summary>The modern Windows "Select Folder" dialog.</summary>
    static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogRcw { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        }

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;

        /// <summary>Returns the chosen folder, or null if the dialog was cancelled.</summary>
        public static string Pick(string title)
        {
            string result = null;
            Exception error = null;
            IntPtr owner = GetForegroundWindow();
            var t = new Thread(() =>
            {
                try
                {
                    var dlg = (IFileDialog)new FileOpenDialogRcw();
                    try
                    {
                        uint opts;
                        dlg.GetOptions(out opts);
                        dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                        dlg.SetTitle(title);
                        if (dlg.Show(owner) == 0)
                        {
                            IShellItem item;
                            dlg.GetResult(out item);
                            string path;
                            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                            result = path;
                            Marshal.ReleaseComObject(item);
                        }
                    }
                    finally { Marshal.ReleaseComObject(dlg); }
                }
                catch (Exception ex) { error = ex; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            t.Join();
            if (error != null) throw new ApiException(500, "Could not open the folder picker: " + error.Message);
            return result;
        }
    }
}
