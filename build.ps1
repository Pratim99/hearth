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
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /warn:3 `
    "/out:$out" "/win32icon:$ico" `
    /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:Microsoft.VisualBasic.dll `
    $sources
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
Write-Host "Built $out"
