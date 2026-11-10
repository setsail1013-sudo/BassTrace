[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$assetDir = Join-Path $projectRoot 'assets'
$source = Join-Path $assetDir 'basstrace-icon.png'
$iconPath = Join-Path $assetDir 'basstrace.ico'
Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile($source)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
try {
    $webRoot = Join-Path $projectRoot 'frontend\public'
    New-Item -ItemType Directory -Path $webRoot -Force | Out-Null
    foreach ($entry in @(@('favicon.png',32), @('apple-touch-icon.png',180), @('basstrace-icon.png',256), @('basstrace-512.png',512))) {
        $webBitmap = [Drawing.Bitmap]::new([int]$entry[1], [int]$entry[1])
        $webGraphics = [Drawing.Graphics]::FromImage($webBitmap)
        try {
            $webGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $webGraphics.DrawImage($image, 0, 0, [int]$entry[1], [int]$entry[1])
            $webBitmap.Save((Join-Path $webRoot $entry[0]), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $webGraphics.Dispose(); $webBitmap.Dispose() }
    }
    foreach ($size in $sizes) {
        $bitmap = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $buffer = [IO.MemoryStream]::new()
        try {
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($image, 0, 0, $size, $size)
            $bitmap.Save($buffer, [Drawing.Imaging.ImageFormat]::Png)
            $frames += ,$buffer.ToArray()
        } finally { $buffer.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $image.Dispose() }
$stream = [IO.File]::Create($iconPath)
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $edge = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$edge); $writer.Write([byte]$edge)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally { $writer.Dispose(); $stream.Dispose() }
$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'BassTrace.lnk'
$oldLinkPath = Join-Path $desktop 'BassChart Studio.lnk'
function Test-OwnedShortcut($path) {
    $existing = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    return ($existing.WorkingDirectory -eq $projectRoot -and $existing.Arguments.Contains((Join-Path $projectRoot 'launch-desktop.ps1')))
}
if ((Test-Path -LiteralPath $linkPath) -and -not (Test-OwnedShortcut $linkPath)) { throw 'An unrelated BassTrace shortcut already exists. It was not changed.' }
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $projectRoot 'launch-desktop.ps1') + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Open BassTrace'
$shortcut.WindowStyle = 7
$shortcut.Save()
if ((Test-Path -LiteralPath $oldLinkPath) -and (Test-OwnedShortcut $oldLinkPath)) { Remove-Item -LiteralPath $oldLinkPath }
Write-Output $linkPath
