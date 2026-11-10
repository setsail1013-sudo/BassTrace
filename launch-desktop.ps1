[CmdletBinding()]
param([ValidateRange(1, 65535)][int]$Port = 8000, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$localUrl = "http://127.0.0.1:$Port"
$launchLock = [Threading.Mutex]::new($false, "Local\BassChartStudio-Launch-$Port")
$ownsLock = $false

function Test-BassChartReady {
    try {
        $health = Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 12
        return ($health.status -eq 'ok' -and $health.capabilities.local -eq $true -and $null -ne $health.capabilities.bassTranscription)
    } catch { return $false }
}

try {
    try { $ownsLock = $launchLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { exit 0 }
    if (-not (Test-BassChartReady)) {
        $logDir = Join-Path $projectRoot 'logs'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $outputLog = Join-Path $logDir "desktop-$stamp.log"
        $errorLog = Join-Path $logDir "desktop-$stamp-error.log"
        $shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $starter = Join-Path $projectRoot 'start.ps1'
        $child = Start-Process -FilePath $shell -ArgumentList "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$starter`" -NoBrowser -Port $Port" -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
        $deadline = (Get-Date).AddMinutes(5)
        $ready = $false
        while ((Get-Date) -lt $deadline) {
            if (Test-BassChartReady) { $ready = $true; break }
            if ($child.HasExited) { throw "Startup stopped. See $outputLog and $errorLog" }
            Start-Sleep -Milliseconds 700
        }
        if (-not $ready) { throw "Startup is taking longer than expected. Check $outputLog before trying again." }
    }
    if (-not $NoBrowser) { Start-Process -FilePath $localUrl }
} catch {
    if ($NoBrowser) { Write-Error $_.Exception.Message; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'BassTrace - Startup', 'OK', 'Error') | Out-Null
    exit 1
} finally {
    if ($ownsLock) { $launchLock.ReleaseMutex() }
    $launchLock.Dispose()
}
