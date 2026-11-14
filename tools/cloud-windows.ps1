# Hearth Cloud Windows
#
# Opens up to three browser windows, side by side, on the AI companies' own websites (Claude, ChatGPT,
# Gemini). This is the only part of Hearth that involves cloud AI, and it is deliberately separate from
# Hearth.exe: Hearth itself never contacts a cloud AI service.
#
# The windows are fenced in three ways:
#   - they use their own browser profile, apart from Hearth and from your everyday browser;
#   - that browser can only reach the sites listed below (plus the sign-in services they rely on),
#     so every other website fails to load, including links that pages try to open;
#   - opening a new set closes the previous one, so there are never more than three.
#
# Usage:
#   cloud-windows.ps1                         show a small picker
#   cloud-windows.ps1 -Sites claude,chatgpt   open these sites directly (one to three of: claude, chatgpt, gemini)
#   cloud-windows.ps1 -Close                  close the cloud windows
#   cloud-windows.ps1 -InstallShortcut        add "Hearth Cloud Windows" to the Start menu
param(
    [string[]]$Sites,
    [switch]$Close,
    [switch]$InstallShortcut
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$MaxWindows = 3

$Catalog = [ordered]@{
    claude  = @{ Name = "Claude";  Url = "https://claude.ai/new";         Hosts = @("claude.ai", "*.claude.ai", "*.anthropic.com", "*.claudeusercontent.com") }
    chatgpt = @{ Name = "ChatGPT"; Url = "https://chatgpt.com/";          Hosts = @("chatgpt.com", "*.chatgpt.com", "*.openai.com", "*.oaistatic.com", "*.oaiusercontent.com") }
    gemini  = @{ Name = "Gemini";  Url = "https://gemini.google.com/app"; Hosts = @("gemini.google.com", "ogs.google.com", "apis.google.com", "*.clients6.google.com", "*.googleusercontent.com") }
}

# Services those sites use for signing in and for "are you human" checks. Nothing else is reachable.
$SignInHosts = @(
    "accounts.google.com", "accounts.youtube.com", "*.gstatic.com", "*.googleapis.com",              # Google sign-in
    "appleid.apple.com", "*.cdn-apple.com",                                                          # Apple sign-in
    "login.microsoftonline.com", "login.live.com", "account.live.com", "*.msauth.net", "*.msftauth.net",  # Microsoft sign-in
    "challenges.cloudflare.com", "*.arkoselabs.com"                                                  # human checks
)

$DataDir    = Join-Path $env:LOCALAPPDATA "Hearth"
$ProfileDir = Join-Path $DataDir "cloud-profile"
$PidFile    = Join-Path $DataDir "cloud-browser.txt"
$PrefsFile  = Join-Path $DataDir "cloud-windows.json"
New-Item -ItemType Directory -Force $DataDir | Out-Null

function Get-AllowedHosts {
    $all = @(); foreach ($s in $Catalog.Values) { $all += $s.Hosts }
    ($all + $SignInHosts) | Select-Object -Unique
}

# The rule the browser is started with: refuse every address except the allowed ones.
function Get-HostRules { "MAP * ~NOTFOUND , " + ((Get-AllowedHosts | ForEach-Object { "EXCLUDE $_" }) -join " , ") }

function Find-Edge {
    foreach ($root in ${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) {
        if (-not $root) { continue }
        $p = Join-Path $root "Microsoft\Edge\Application\msedge.exe"
        if (Test-Path $p) { return $p }
    }
    throw "Microsoft Edge is needed for the cloud windows, and it was not found on this PC."
}

# The cloud browser this launcher started earlier, if it is still running.
function Get-CloudBrowser {
    try {
        if (-not (Test-Path $PidFile)) { return $null }
        $parts = (Get-Content $PidFile -Raw).Trim().Split("|")
        $p = Get-Process -Id ([int]$parts[0]) -ErrorAction Stop
        if ($p.ProcessName -ne "msedge") { return $null }
        if ($parts.Count -gt 1 -and $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $parts[1]) { return $null }   # a recycled process id
        return $p
    } catch { return $null }
}

# Small Windows helper: find the cloud browser's windows, place them, and ask them to close.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HearthCloudWindows
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

    /// <summary>The browser's real, visible windows (not its hidden helper windows).</summary>
    public static IntPtr[] Find(int pid)
    {
        var list = new List<IntPtr>();
        EnumWindows((h, l) =>
        {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != (uint)pid || !IsWindowVisible(h)) return true;
            var cls = new StringBuilder(64); GetClassName(h, cls, 64);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            RECT r; GetWindowRect(h, out r);
            if (r.R - r.L < 300 || r.B - r.T < 200) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static void Place(IntPtr hwnd, int x, int y, int w, int h)
    {
        ShowWindow(hwnd, 9);                                  // restore if maximized or minimized
        SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, 0x0014);  // keep stacking order, do not steal focus
    }

    public static void Close(IntPtr hwnd) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

function Close-CloudWindows {
    $p = Get-CloudBrowser
    if ($p) {
        # Ask each window to close, as if its X had been pressed, so the browser shuts down normally.
        foreach ($w in [HearthCloudWindows]::Find($p.Id)) { [HearthCloudWindows]::Close($w) }
        if (-not $p.WaitForExit(7000)) { try { Stop-Process -Id $p.Id -Force; $p.WaitForExit(4000) | Out-Null } catch { } }
        Start-Sleep -Milliseconds 800
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Open-CloudWindows([string[]]$ids) {
    $ids = @($ids | Where-Object { $_ } | ForEach-Object { $_.Trim().ToLowerInvariant() })
    if ($ids.Count -eq 0) { throw "Choose at least one site to open." }
    if ($ids.Count -gt $MaxWindows) { throw "At most $MaxWindows cloud windows can be open at a time." }
    foreach ($id in $ids) { if (-not $Catalog.Contains($id)) { throw "'$id' is not on the list of AI sites (claude, chatgpt, gemini)." } }

    $edge = Find-Edge
    Close-CloudWindows                       # replace the previous set, so there are never more than three
    New-Item -ItemType Directory -Force $ProfileDir | Out-Null

    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $width = [int][math]::Floor($area.Width / $ids.Count)
    $rules = Get-HostRules
    $edgeBorder = 7          # Windows draws an invisible resize border around each window; overlap it so the tiles meet
    $count = $ids.Count
    # Where window $i goes. Neighbouring tiles overlap that invisible border so they meet, but nothing
    # reaches past the screen's own edges, where it would spill onto another display.
    function Get-Slot([int]$i) {
        $leftOver = 0; if ($i -gt 0) { $leftOver = $edgeBorder }
        $rightOver = 0; if ($i -lt $count - 1) { $rightOver = $edgeBorder }
        return @(($area.Left + $i * $width - $leftOver), $area.Top, ($width + $leftOver + $rightOver), $area.Height)
    }
    $browserId = 0
    $placed = @()
    for ($i = 0; $i -lt $ids.Count; $i++) {
        $site = $Catalog[$ids[$i]]
        $argList = @(
            "--app=`"$($site.Url)`"",
            "--user-data-dir=`"$ProfileDir`"",
            "--host-resolver-rules=`"$rules`"",
            "--window-size=$width,$($area.Height)",
            "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"
        )
        $p = Start-Process -FilePath $edge -ArgumentList $argList -PassThru
        if ($i -eq 0) {
            # The first launch is the browser itself; later launches only ask it for another window.
            $browserId = $p.Id
            Set-Content -Path $PidFile -Value ("{0}|{1}" -f $p.Id, $p.StartTime.ToUniversalTime().Ticks) -Encoding ascii
        }
        # Wait for this window to appear, then put it in its slot. (The browser only honours a
        # position given on its command line for the very first window, so each one is placed here.)
        $new = $null
        for ($try = 0; $try -lt 60 -and -not $new; $try++) {
            Start-Sleep -Milliseconds 250
            $new = [HearthCloudWindows]::Find($browserId) | Where-Object { $placed -notcontains $_ } | Select-Object -First 1
        }
        if ($new) {
            $s = Get-Slot $i
            [HearthCloudWindows]::Place($new, $s[0], $s[1], $s[2], $s[3])
            $placed += $new
        }
    }
    # The browser re-applies each window's remembered size a moment after it appears, so place them again.
    for ($pass = 0; $pass -lt 3; $pass++) {
        Start-Sleep -Milliseconds 900
        for ($i = 0; $i -lt $placed.Count; $i++) {
            $s = Get-Slot $i
            [HearthCloudWindows]::Place($placed[$i], $s[0], $s[1], $s[2], $s[3])
        }
    }
    @{ sites = $ids } | ConvertTo-Json | Set-Content -Path $PrefsFile -Encoding ascii
    if ($placed.Count -lt $ids.Count) { throw "Only $($placed.Count) of $($ids.Count) cloud windows opened. Try again." }
}

function Install-Shortcut {
    $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "Hearth Cloud Windows.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $sc.WorkingDirectory = Split-Path $PSCommandPath
    $sc.WindowStyle = 7
    $sc.Description = "Open Claude, ChatGPT or Gemini in restricted browser windows, side by side"
    $exe = Join-Path (Split-Path (Split-Path $PSCommandPath)) "Hearth.exe"
    if (Test-Path $exe) { $sc.IconLocation = "$exe,0" }
    $sc.Save()
    return $lnk
}

function Show-Picker {
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $last = @("claude", "chatgpt", "")
    try { $saved = @((Get-Content $PrefsFile -Raw | ConvertFrom-Json).sites); if ($saved.Count) { $last = $saved + @("", "", "") } } catch { }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Hearth Cloud Windows"
    $form.ClientSize = New-Object System.Drawing.Size(470, 318)
    $form.StartPosition = "CenterScreen"; $form.FormBorderStyle = "FixedDialog"; $form.MaximizeBox = $false; $form.MinimizeBox = $false
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
    $exe = Join-Path (Split-Path (Split-Path $PSCommandPath)) "Hearth.exe"
    if (Test-Path $exe) { try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe) } catch { } }

    $note = New-Object System.Windows.Forms.Label
    $note.Location = New-Object System.Drawing.Point(18, 14); $note.Size = New-Object System.Drawing.Size(434, 92)
    $note.Text = "These windows are the only part of Hearth that uses cloud AI. They open the AI companies' own websites in a separate browser that can reach nothing else. What you type there goes to those companies. Hearth itself still sends nothing, and your local chats and files stay on this PC."
    $form.Controls.Add($note)

    $names = @("(none)") + @($Catalog.Values | ForEach-Object { $_.Name })
    $keys = @("") + @($Catalog.Keys)
    $combos = @()
    for ($i = 0; $i -lt $MaxWindows; $i++) {
        $lbl = New-Object System.Windows.Forms.Label
        $lbl.Location = New-Object System.Drawing.Point(18, (118 + $i * 38)); $lbl.Size = New-Object System.Drawing.Size(90, 24); $lbl.Text = "Window $($i + 1)"
        $cb = New-Object System.Windows.Forms.ComboBox
        $cb.Location = New-Object System.Drawing.Point(112, (114 + $i * 38)); $cb.Size = New-Object System.Drawing.Size(340, 26); $cb.DropDownStyle = "DropDownList"
        [void]$cb.Items.AddRange($names)
        $idx = [array]::IndexOf($keys, [string]$last[$i]); if ($idx -lt 0) { $idx = 0 }
        $cb.SelectedIndex = $idx
        $form.Controls.Add($lbl); $form.Controls.Add($cb); $combos += $cb
    }

    $open = New-Object System.Windows.Forms.Button
    $open.Text = "Open side by side"; $open.Location = New-Object System.Drawing.Point(292, 270); $open.Size = New-Object System.Drawing.Size(160, 32)
    $closeBtn = New-Object System.Windows.Forms.Button
    $closeBtn.Text = "Close cloud windows"; $closeBtn.Location = New-Object System.Drawing.Point(18, 270); $closeBtn.Size = New-Object System.Drawing.Size(160, 32)
    $closeBtn.Enabled = [bool](Get-CloudBrowser)
    $limit = New-Object System.Windows.Forms.Label
    $limit.Location = New-Object System.Drawing.Point(18, 232); $limit.Size = New-Object System.Drawing.Size(434, 30); $limit.ForeColor = [System.Drawing.SystemColors]::GrayText
    $limit.Text = "Up to $MaxWindows windows. Opening a new set closes the previous one."
    $form.Controls.Add($limit); $form.Controls.Add($open); $form.Controls.Add($closeBtn)
    $form.AcceptButton = $open

    $script:picked = $null
    $open.Add_Click({
        $ids = @($combos | ForEach-Object { $keys[$_.SelectedIndex] } | Where-Object { $_ })
        if ($ids.Count -eq 0) { [void][System.Windows.Forms.MessageBox]::Show("Choose at least one site.", "Hearth Cloud Windows"); return }
        $script:picked = $ids; $form.Close()
    })
    $closeBtn.Add_Click({ Close-CloudWindows; $closeBtn.Enabled = $false })
    [void]$form.ShowDialog()
    return $script:picked
}

try {
    if ($InstallShortcut) { $path = Install-Shortcut; Write-Output "Shortcut created: $path"; return }
    if ($Close) { Close-CloudWindows; return }
    if ($Sites) { Open-CloudWindows (@($Sites) -split ","); return }
    $choice = Show-Picker
    if ($choice) { Open-CloudWindows $choice }
} catch {
    if ($Sites -or $Close -or $InstallShortcut) { throw }
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Hearth Cloud Windows", "OK", "Error")
}
