# Builds Hearth.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
# No SDKs, package managers or downloads are needed.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "The .NET Framework C# compiler was not found at $csc" }

$ico = Join-Path $root "app\hearth.ico"
if (-not (Test-Path $ico)) { & (Join-Path $root "tools\make-icon.ps1") -Out $ico }

$out = Join-Path $root "Hearth.exe"
$sources = Get-ChildItem (Join-Path $root "src") -Filter *.cs | ForEach-Object { $_.FullName }

# The interface (everything under app\) is built into the exe, so Hearth.exe runs on its own from any folder.
$appDir = Join-Path $root "app"
$resources = Get-ChildItem $appDir -Recurse -File | ForEach-Object {
    "/resource:" + $_.FullName + ",app/" + $_.FullName.Substring($appDir.Length + 1).Replace('\', '/')
}
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /warn:3 `
    "/out:$out" "/win32icon:$ico" `
    /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:Microsoft.VisualBasic.dll `
    $resources $sources
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
Write-Host "Built $out"
