# Draws the Hearth icon and writes app\hearth.ico (PNG-encoded entries at several sizes).
param([string]$Out = (Join-Path $PSScriptRoot "..\app\hearth.ico"))

Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 24.0

    # Rounded tile
    $r = 5.6 * $s; $d = $r * 2; $w = $size
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($w - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($w - $d, $w - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $w - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(0, $w)),
        [System.Drawing.Color]::FromArgb(255, 38, 30, 26), [System.Drawing.Color]::FromArgb(255, 20, 17, 15))
    $g.FillPath($bg, $tile)

    function P([double]$x, [double]$y) { New-Object System.Drawing.PointF(($x * $s), ($y * $s)) }

    # Outer flame
    $flame = New-Object System.Drawing.Drawing2D.GraphicsPath
    $flame.AddBezier((P 12 3.4), (P 12.8 6.8), (P 17 8.7), (P 17 13.6))
    $flame.AddBezier((P 17 13.6), (P 17 16.7), (P 14.8 19.2), (P 12 19.2))
    $flame.AddBezier((P 12 19.2), (P 9.2 19.2), (P 7 16.7), (P 7 13.6))
    $flame.AddBezier((P 7 13.6), (P 7 11.7), (P 7.8 10.3), (P 8.8 9.1))
    $flame.AddBezier((P 8.8 9.1), (P 9 10.7), (P 9.8 11.7), (P 10.8 11.9))
    $flame.AddBezier((P 10.8 11.9), (P 10.2 8.6), (P 10.8 5.7), (P 12 3.4))
    $flame.CloseFigure()
    $fb = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (P 0 3), (P 0 19.5),
        [System.Drawing.Color]::FromArgb(255, 255, 186, 104), [System.Drawing.Color]::FromArgb(255, 238, 96, 44))
    $g.FillPath($fb, $flame)

    # Inner flame
    $core = New-Object System.Drawing.Drawing2D.GraphicsPath
    $core.AddBezier((P 12 12.8), (P 13.2 14.2), (P 14.1 15.1), (P 14.1 16.4))
    $core.AddBezier((P 14.1 16.4), (P 14.1 17.7), (P 13.2 18.5), (P 12 18.5))
    $core.AddBezier((P 12 18.5), (P 10.8 18.5), (P 9.9 17.7), (P 9.9 16.4))
    $core.AddBezier((P 9.9 16.4), (P 9.9 15.1), (P 10.8 14.2), (P 12 12.8))
    $core.CloseFigure()
    $cb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 232, 190))
    $g.FillPath($cb, $core)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 256
$images = @()
foreach ($sz in $sizes) { $images += ,(New-IconPng $sz) }

$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = $sizes[$i]; if ($dim -ge 256) { $dim = 0 }
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$images[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Close(); $fs.Close()
Write-Host "Wrote $Out"
