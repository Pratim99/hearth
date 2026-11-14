# Hearth window
#
# One window with two tabs:
#   Hearth  - the local AI workbench (served by Hearth.exe on this PC, exactly as before)
#   Cloud   - Claude, ChatGPT and Gemini side by side, three panes, so you can use whichever suits the
#             task. This tab is the only part of Hearth that involves cloud AI. The panes are the AI
#             companies' own websites; they do not talk to each other or to the Hearth tab.
#
# The Cloud tab is fenced off:
#   - its panes use their own browser profile, separate from the Hearth tab and from your everyday browser;
#   - that profile can only reach the AI sites listed below (plus the sign-in services they rely on);
#     every other address fails to load;
#   - nothing in it loads until you open the tab for the first time.
#
# Hearth.exe is not changed by this: it still runs on its own (without the Cloud tab) if started directly.
#
# Usage:
#   hearth-window.ps1                    open the window
#   hearth-window.ps1 -InstallShortcut   make the Start menu "Hearth" shortcut open this window
param(
    [switch]$InstallShortcut,
    [string]$SelfTest        # internal: write a short report to this file, then exit
)
$ErrorActionPreference = "Stop"

$ToolsDir = Split-Path -Parent $PSCommandPath
$Root     = Split-Path -Parent $ToolsDir
$Exe      = Join-Path $Root "Hearth.exe"
$Sdk      = Join-Path $ToolsDir "webview2"
$DataDir  = Join-Path $env:LOCALAPPDATA "Hearth"
$PrefsFile = Join-Path $DataDir "cloud-panes.json"

$Catalog = [ordered]@{
    claude  = @{ Name = "Claude";  Url = "https://claude.ai/new";         Hosts = @("claude.ai", "*.claude.ai", "*.anthropic.com", "*.claudeusercontent.com") }
    chatgpt = @{ Name = "ChatGPT"; Url = "https://chatgpt.com/";          Hosts = @("chatgpt.com", "*.chatgpt.com", "*.openai.com", "*.oaistatic.com", "*.oaiusercontent.com") }
    gemini  = @{ Name = "Gemini";  Url = "https://gemini.google.com/app"; Hosts = @("gemini.google.com", "ogs.google.com", "apis.google.com", "*.clients6.google.com", "*.googleusercontent.com") }
}
# Services those sites use for signing in and for "are you human" checks. Nothing else is reachable.
$SignInHosts = @(
    "accounts.google.com", "accounts.youtube.com", "*.gstatic.com", "*.googleapis.com",
    "appleid.apple.com", "*.cdn-apple.com",
    "login.microsoftonline.com", "login.live.com", "account.live.com", "*.msauth.net", "*.msftauth.net",
    "challenges.cloudflare.com", "*.arkoselabs.com"
)
$AllowedHosts = @(); foreach ($s in $Catalog.Values) { $AllowedHosts += $s.Hosts }; $AllowedHosts = @(($AllowedHosts + $SignInHosts) | Select-Object -Unique)
$HostRules = "MAP * ~NOTFOUND , " + (($AllowedHosts | ForEach-Object { "EXCLUDE $_" }) -join " , ")

function Test-AllowedHost([string]$hostName) {
    foreach ($h in $AllowedHosts) {
        if ($h.StartsWith("*.")) { if ($hostName.EndsWith($h.Substring(1), [StringComparison]::OrdinalIgnoreCase)) { return $true } }
        elseif ($hostName.Equals($h, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Install-Shortcut {
    $lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "Hearth.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $sc.WorkingDirectory = $Root
    $sc.WindowStyle = 7
    $sc.Description = "Hearth - local AI workbench, with a Cloud tab"
    if (Test-Path $Exe) { $sc.IconLocation = "$Exe,0" }
    $sc.Save()
    return $lnk
}
if ($InstallShortcut) { Write-Output ("Shortcut updated: " + (Install-Shortcut)); return }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class HearthShell
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
}
'@
[void][HearthShell]::SetProcessDPIAware()                                   # crisp text on scaled displays
[void][HearthShell]::SetCurrentProcessExplicitAppUserModelID("Hearth.Window")  # its own taskbar button and icon

function Show-Error([string]$text) { [void][System.Windows.Forms.MessageBox]::Show($text, "Hearth", "OK", "Error") }

try {
    if (-not (Test-Path (Join-Path $Sdk "Microsoft.Web.WebView2.WinForms.dll"))) { throw "The tools\webview2 folder is missing, so the Hearth window cannot open. Hearth.exe still works on its own." }
    if (-not (Test-Path $Exe)) { throw "Hearth.exe was not found next to the tools folder. Build it first with build.ps1." }
    $env:PATH = "$Sdk;$env:PATH"
    Add-Type -Path (Join-Path $Sdk "Microsoft.Web.WebView2.Core.dll")
    Add-Type -Path (Join-Path $Sdk "Microsoft.Web.WebView2.WinForms.dll")
    New-Item -ItemType Directory -Force $DataDir | Out-Null

    # ------------------------------------------------------------ start (or join) the local Hearth service
    $sessionFile = Join-Path $DataDir "session.txt"
    function Get-LiveSession {
        try {
            if (-not (Test-Path $sessionFile)) { return $null }
            $u = (Get-Content $sessionFile -Raw).Trim()
            $port = ([uri]$u).Port
            $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/ping" -TimeoutSec 2
            if ($r.StatusCode -eq 200) { return $u }
        } catch { }
        return $null
    }
    $session = Get-LiveSession
    if (-not $session) {
        Start-Process -FilePath $Exe -ArgumentList "--no-window" | Out-Null
        for ($i = 0; $i -lt 60 -and -not $session; $i++) { Start-Sleep -Milliseconds 250; $session = Get-LiveSession }
    }
    if (-not $session) { throw "Hearth's local service did not start. Try running Hearth.exe directly to see what Windows reports." }
    $hearthOrigin = ([uri]$session).GetLeftPart([UriPartial]::Authority)

    # ------------------------------------------------------------ window
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $bg = [System.Drawing.Color]::FromArgb(24, 22, 20); $bgActive = [System.Drawing.Color]::FromArgb(37, 34, 32)
    $fg = [System.Drawing.Color]::FromArgb(236, 231, 225); $fgDim = [System.Drawing.Color]::FromArgb(170, 162, 154)
    $accent = [System.Drawing.Color]::FromArgb(240, 138, 75); $warn = [System.Drawing.Color]::FromArgb(227, 178, 76)
    $ui = New-Object System.Drawing.Font("Segoe UI", 9.5)

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Hearth"; $form.Font = $ui; $form.BackColor = $bg
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Size = New-Object System.Drawing.Size([math]::Min(1600, [int]($wa.Width * 0.86)), [math]::Min(1000, [int]($wa.Height * 0.9)))
    $form.StartPosition = "CenterScreen"; $form.MinimumSize = New-Object System.Drawing.Size(900, 600)
    try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe) } catch { }

    $content = New-Object System.Windows.Forms.Panel; $content.Dock = "Fill"
    $strip = New-Object System.Windows.Forms.Panel; $strip.Dock = "Top"; $strip.Height = 40; $strip.BackColor = $bg
    $form.Controls.Add($content); $form.Controls.Add($strip)

    function New-TabButton([string]$text, [int]$left, [int]$width) {
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $text; $b.FlatStyle = "Flat"; $b.FlatAppearance.BorderSize = 0; $b.ForeColor = $fgDim; $b.BackColor = $bg
        $b.FlatAppearance.MouseOverBackColor = $bgActive; $b.FlatAppearance.MouseDownBackColor = $bgActive
        $b.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10); $b.TabStop = $false
        $b.Location = New-Object System.Drawing.Point($left, 4); $b.Size = New-Object System.Drawing.Size($width, 32)
        $strip.Controls.Add($b); return $b
    }
    $tabHearth = New-TabButton "Hearth" 8 110
    $tabCloud = New-TabButton "Cloud AI" 122 120
    $note = New-Object System.Windows.Forms.Label
    $note.AutoSize = $false; $note.Location = New-Object System.Drawing.Point(256, 4); $note.Size = New-Object System.Drawing.Size(1200, 32)
    $note.TextAlign = "MiddleLeft"; $note.ForeColor = $warn; $note.Visible = $false
    $note.Text = "Not local: these panes are the AI companies' own websites. What you type here goes to them. The Hearth tab stays on this PC."
    $strip.Controls.Add($note)

    # ---- Hearth tab
    $hearthView = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $hearthProps = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
    $hearthProps.UserDataFolder = Join-Path $DataDir "window-view"
    $hearthView.CreationProperties = $hearthProps
    $hearthView.Dock = "Fill"; $hearthView.DefaultBackgroundColor = $bg
    $hearthView.add_CoreWebView2InitializationCompleted({
        param($s, $e)
        if (-not $e.IsSuccess) { return }
        $s.CoreWebView2.Settings.IsStatusBarEnabled = $false
        # Links to outside pages open in your normal browser; this view only ever shows Hearth itself.
        $s.CoreWebView2.add_NewWindowRequested({ param($s2, $e2) $e2.Handled = $true; if ($e2.Uri -match '^https://') { Start-Process $e2.Uri } })
        $s.CoreWebView2.add_NavigationStarting({ param($s2, $e2) if (-not $e2.Uri.StartsWith($hearthOrigin)) { $e2.Cancel = $true; if ($e2.Uri -match '^https://') { Start-Process $e2.Uri } } })
    })
    $content.Controls.Add($hearthView)
    $hearthView.Source = [uri]$session

    # ---- Cloud tab: three panes, created the first time the tab is opened
    $cloudView = New-Object System.Windows.Forms.Panel; $cloudView.Dock = "Fill"; $cloudView.Visible = $false; $cloudView.BackColor = $bg
    $content.Controls.Add($cloudView)
    $script:panes = @()
    $keys = @($Catalog.Keys); $names = @($Catalog.Values | ForEach-Object { $_.Name })
    $saved = @("claude", "chatgpt", "gemini")
    try { $p = @((Get-Content $PrefsFile -Raw | ConvertFrom-Json).panes); if ($p.Count -eq 3) { $saved = $p } } catch { }

    function Save-Panes { try { @{ panes = @($script:panes | ForEach-Object { $keys[$_.Combo.SelectedIndex] }) } | ConvertTo-Json | Set-Content -Path $PrefsFile -Encoding ascii } catch { } }

    function New-Pane([string]$siteKey) {
        $pane = New-Object System.Windows.Forms.Panel; $pane.Dock = "Fill"; $pane.BackColor = $bg
        $head = New-Object System.Windows.Forms.Panel; $head.Dock = "Top"; $head.Height = 34; $head.BackColor = $bgActive
        $combo = New-Object System.Windows.Forms.ComboBox; $combo.DropDownStyle = "DropDownList"; $combo.Location = New-Object System.Drawing.Point(8, 5); $combo.Size = New-Object System.Drawing.Size(150, 24)
        [void]$combo.Items.AddRange($names); $idx = [array]::IndexOf($keys, $siteKey); if ($idx -lt 0) { $idx = 0 }; $combo.SelectedIndex = $idx
        $mk = { param($text, $left, $tip) $b = New-Object System.Windows.Forms.Button; $b.Text = $text; $b.FlatStyle = "Flat"; $b.FlatAppearance.BorderSize = 0; $b.ForeColor = $fg; $b.BackColor = $bgActive; $b.TabStop = $false
                $b.Location = New-Object System.Drawing.Point($left, 3); $b.Size = New-Object System.Drawing.Size(64, 28); $head.Controls.Add($b); $b }
        $backBtn = & $mk "Back" 166; $reloadBtn = & $mk "Reload" 232; $homeBtn = & $mk "Home" 298
        $head.Controls.Add($combo)

        $view = New-Object Microsoft.Web.WebView2.WinForms.WebView2
        $props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
        $props.UserDataFolder = Join-Path $DataDir "cloud-view"                       # the Cloud tab's own profile
        $props.AdditionalBrowserArguments = "--host-resolver-rules=`"$HostRules`""    # only the allowed sites resolve
        $view.CreationProperties = $props
        $view.Dock = "Fill"; $view.DefaultBackgroundColor = $bg
        $view.add_CoreWebView2InitializationCompleted({
            param($s, $e)
            if (-not $e.IsSuccess) { return }
            $s.CoreWebView2.Settings.IsStatusBarEnabled = $false
            # Second fence: even a page that somehow resolved is not shown unless its site is on the list.
            $s.CoreWebView2.add_NavigationStarting({ param($s2, $e2) try { $u = [uri]$e2.Uri; if ($u.Scheme -ne "https" -or -not (Test-AllowedHost $u.Host)) { $e2.Cancel = $true } } catch { $e2.Cancel = $true } })
        })
        $pane.Controls.Add($view); $pane.Controls.Add($head)

        # Each control carries its own pane in .Tag, so the handlers below know which pane they belong to.
        $entry = [pscustomobject]@{ Panel = $pane; Combo = $combo; View = $view }
        foreach ($c in $combo, $backBtn, $reloadBtn, $homeBtn) { $c.Tag = $entry }
        $combo.add_SelectedIndexChanged({ param($s, $e) $s.Tag.View.Source = [uri]$Catalog[$keys[$s.SelectedIndex]].Url; Save-Panes })
        $backBtn.add_Click({ param($s, $e) $v = $s.Tag.View.CoreWebView2; if ($v -and $v.CanGoBack) { $v.GoBack() } })
        $reloadBtn.add_Click({ param($s, $e) $v = $s.Tag.View.CoreWebView2; if ($v) { $v.Reload() } })
        $homeBtn.add_Click({ param($s, $e) $s.Tag.View.Source = [uri]$Catalog[$keys[$s.Tag.Combo.SelectedIndex]].Url })
        $view.Source = [uri]$Catalog[$keys[$combo.SelectedIndex]].Url
        return $entry
    }

    function Build-Cloud {
        if ($script:panes.Count) { return }
        $outer = New-Object System.Windows.Forms.SplitContainer; $outer.Dock = "Fill"; $outer.SplitterWidth = 5; $outer.BackColor = $bg
        $inner = New-Object System.Windows.Forms.SplitContainer; $inner.Dock = "Fill"; $inner.SplitterWidth = 5; $inner.BackColor = $bg
        $cloudView.Controls.Add($outer); $outer.Panel2.Controls.Add($inner)
        $a = New-Pane $saved[0]; $b = New-Pane $saved[1]; $c = New-Pane $saved[2]
        $outer.Panel1.Controls.Add($a.Panel); $inner.Panel1.Controls.Add($b.Panel); $inner.Panel2.Controls.Add($c.Panel)
        $script:panes = @($a, $b, $c)
        # Three equal panes to start with; after that the dividers can be dragged, and resizing the
        # window keeps their proportions.
        $cloudView.PerformLayout()
        $w = $outer.ClientSize.Width
        if ($w -gt 600) {
            $outer.SplitterDistance = [int](($w - 2 * $outer.SplitterWidth) / 3)
            $outer.PerformLayout()
            $inner.SplitterDistance = [int](($inner.ClientSize.Width - $inner.SplitterWidth) / 2)
        }
    }

    function Show-Tab([string]$which) {
        $cloud = $which -eq "cloud"
        $cloudView.Visible = $cloud; $hearthView.Visible = -not $cloud; $note.Visible = $cloud
        if ($cloud) { Build-Cloud }        # after it is visible, so the panes are sized against the real width
        foreach ($pair in @(@($tabHearth, (-not $cloud)), @($tabCloud, $cloud))) {
            $pair[0].BackColor = if ($pair[1]) { $bgActive } else { $bg }
            $pair[0].ForeColor = if ($pair[1]) { $fg } else { $fgDim }
        }
        if ($cloud) { $tabCloud.ForeColor = $warn }
    }
    $tabHearth.add_Click({ Show-Tab "hearth" })
    $tabCloud.add_Click({ Show-Tab "cloud" })
    Show-Tab "hearth"

    # ------------------------------------------------------------ self-test (used while developing)
    if ($SelfTest) {
        $script:step = 0; $script:report = @(); $script:blocked = "no result"
        $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 1000
        $timer.add_Tick({
            $script:step++
            try {
                if ($script:step -eq 8) { $script:report += "hearth tab: title=[" + $hearthView.CoreWebView2.DocumentTitle + "] url=" + ($hearthView.Source.GetLeftPart([UriPartial]::Path)); Show-Tab "cloud" }
                if ($script:step -eq 22) {
                    foreach ($p in $script:panes) { $script:report += "cloud pane " + $keys[$p.Combo.SelectedIndex] + ": title=[" + $p.View.CoreWebView2.DocumentTitle + "] host=" + $p.View.Source.Host }
                    $script:report += "panes: " + $script:panes.Count + " | widths: " + (($script:panes | ForEach-Object { $_.Panel.Width }) -join ",") + " of " + $cloudView.ClientSize.Width
                    $probe = $script:panes[2].View
                    $probe.CoreWebView2.add_NavigationCompleted({ param($s, $e) $script:blocked = "success=" + $e.IsSuccess + " status=" + $e.WebErrorStatus })
                    # A page inside an allowed site trying to pull in an outside address:
                    [void]$probe.CoreWebView2.ExecuteScriptAsync("fetch('https://example.org/').then(()=>document.title='OUTSIDE-REACHED').catch(()=>document.title='OUTSIDE-BLOCKED')")
                }
                if ($script:step -eq 27) {
                    $script:report += "fetch to example.org from inside a pane: title=[" + $script:panes[2].View.CoreWebView2.DocumentTitle + "]"
                    $script:panes[2].View.CoreWebView2.Navigate("https://example.org/")     # a top-level navigation to an outside site
                }
                if ($script:step -eq 31) {
                    $script:report += "navigating a pane to example.org: still on host=" + $script:panes[2].View.Source.Host
                    $script:report += "processes for the cloud profile use the host rule: " + [bool](@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*cloud-view*' -and $_.CommandLine -like '*host-resolver-rules*' }).Count)
                    $script:report += "hearth and cloud profiles are separate: " + ((Join-Path $DataDir "window-view") -ne (Join-Path $DataDir "cloud-view"))
                    Set-Content -Path $SelfTest -Value $script:report -Encoding ascii
                    $timer.Stop(); $form.Close()
                }
            } catch { $script:report += "ERROR at step " + $script:step + ": " + $_.Exception.Message; Set-Content -Path $SelfTest -Value $script:report -Encoding ascii; $timer.Stop(); $form.Close() }
        })
        $form.add_Shown({ $timer.Start() })
    }

    [void]$form.ShowDialog()
} catch {
    if ($SelfTest) { Set-Content -Path $SelfTest -Value ("FAILED: " + $_.Exception.Message + " @ " + $_.InvocationInfo.ScriptLineNumber) -Encoding ascii }
    else { Show-Error $_.Exception.Message }
}
