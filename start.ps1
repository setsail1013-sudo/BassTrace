[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8000,
    [switch]$NoBrowser,
    [switch]$Reinstall,
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$venvRoot = Join-Path $projectRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$requirementsPath = Join-Path $projectRoot 'requirements.txt'
$frontendRoot = Join-Path $projectRoot 'frontend'
$browserJob = $null

function Get-LocalFileHash {
    param([string]$Path)
    # The desktop uses Windows PowerShell; do not depend on modules inherited
    # from a PowerShell 7 caller's PSModulePath.
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Invoke-CheckedCommand {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Executable"
    }
}

function Get-DependencyHash {
    $hashItems = @()
    foreach ($dependencyFile in @('package.json', 'package-lock.json')) {
        $dependencyPath = Join-Path $frontendRoot $dependencyFile
        if (Test-Path -LiteralPath $dependencyPath) {
            $hashItems += Get-LocalFileHash $dependencyPath
        }
    }
    return ($hashItems -join ':')
}

function Get-FrontendSourceHash {
    $sourceFiles = @()
    foreach ($sourceFolder in @('src', 'public', 'scripts')) {
        $sourcePath = Join-Path $frontendRoot $sourceFolder
        if (Test-Path -LiteralPath $sourcePath) {
            $sourceFiles += Get-ChildItem -LiteralPath $sourcePath -Recurse -File
        }
    }
    $sourceFiles += Get-ChildItem -LiteralPath $frontendRoot -File | Where-Object {
        $_.Name -eq 'index.html' -or $_.Name -eq 'package.json' -or $_.Name -eq 'package-lock.json' -or
        $_.Name -like 'tsconfig*.json' -or $_.Name -like 'vite.config.*'
    }
    $hashItems = foreach ($sourceFile in ($sourceFiles | Sort-Object FullName)) {
        $relativePath = $sourceFile.FullName.Substring($frontendRoot.Length)
        $relativePath + ':' + (Get-LocalFileHash $sourceFile.FullName)
    }
    return ($hashItems -join '|')
}

function Test-Stamp {
    param([string]$StampPath, [string]$ExpectedValue)
    if (-not (Test-Path -LiteralPath $StampPath)) { return $false }
    return (([string](Get-Content -LiteralPath $StampPath -Raw)).Trim() -eq $ExpectedValue)
}

try {
    if (-not (Test-Path -LiteralPath $requirementsPath)) {
        throw 'requirements.txt is missing. Please keep the complete project folder together.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'package.json'))) {
        throw 'frontend/package.json is missing. Please keep the complete project folder together.'
    }

    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Host 'Creating the local Python environment...'
        $pythonLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($pythonLauncher) {
            Invoke-CheckedCommand -Executable $pythonLauncher.Source -Arguments @('-3', '-m', 'venv', $venvRoot)
        } elseif ($pythonCommand) {
            Invoke-CheckedCommand -Executable $pythonCommand.Source -Arguments @('-m', 'venv', $venvRoot)
        } else {
            throw 'Python was not found. Install Python 3.11 or newer, enable its launcher or add Python to PATH, then try again.'
        }
    }

    Invoke-CheckedCommand -Executable $venvPython -Arguments @('-c', "import sys; assert sys.version_info >= (3, 11), 'Python 3.11 or newer is required'")
    $requirementsHash = Get-LocalFileHash $requirementsPath
    $pythonStamp = Join-Path $venvRoot '.basschart-requirements.sha256'
    & $venvPython -c "import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(name) is not None for name in ('fastapi', 'uvicorn', 'numpy', 'multipart', 'scipy', 'soundfile', 'httpx')) else 1)"
    $pythonImportsReady = $LASTEXITCODE -eq 0
    if ($Reinstall -or -not $pythonImportsReady -or -not (Test-Stamp $pythonStamp $requirementsHash)) {
        Write-Host 'Installing Python dependencies (internet access may be required)...'
        try {
            Invoke-CheckedCommand -Executable $venvPython -Arguments @('-m', 'pip', 'install', '-r', $requirementsPath)
        } catch {
            throw 'Python dependency installation failed. Review the output above. Check internet access, Python compatibility, Windows proxy settings, terminal proxy variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY), and pip configuration. Correct stale settings, then restart.'
        }
        Set-Content -LiteralPath $pythonStamp -Value $requirementsHash -Encoding ASCII
    }

    # Keep optional separation models in their existing environment. Selection
    # affects this launcher process only and never installs or changes packages.
    if ([string]::IsNullOrWhiteSpace($env:BASSCHART_DEMUCS_PYTHON)) {
        & $venvPython -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('demucs') is not None else 1)"
        if ($LASTEXITCODE -ne 0) {
            $existingModelPython = Get-Command python.exe -ErrorAction SilentlyContinue
            $modelPythonPath = if ($existingModelPython -and $existingModelPython.Source -notmatch '\\WindowsApps\\') { $existingModelPython.Source } else { (& $venvPython -c "import sys; print(sys._base_executable)").Trim() }
            if ($modelPythonPath -and (Test-Path -LiteralPath $modelPythonPath)) {
                $demucsProbe = "import sys`ntry:`n import demucs.separate`nexcept Exception:`n sys.exit(1)"
                & $modelPythonPath -c $demucsProbe *> $null
                if ($LASTEXITCODE -eq 0) {
                    $env:BASSCHART_DEMUCS_PYTHON = $modelPythonPath
                    Write-Host 'Using the existing Python environment for Demucs separation.'
                }
            }
        }
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $env:BASSCHART_NODE = $nodeCommand.Source }
    if (-not $npmCommand) {
        throw 'Node.js / npm was not found. Install Node.js 20.19+ or 22.12+, reopen the terminal, then try again.'
    }
    Push-Location -LiteralPath $frontendRoot
    try {
        $npmStamp = Join-Path $frontendRoot 'node_modules\.basschart-dependencies.sha256'
        $dependencyHash = Get-DependencyHash
        $viteCommand = Join-Path $frontendRoot 'node_modules\.bin\vite.cmd'
        if ($Reinstall -or -not (Test-Path -LiteralPath $viteCommand) -or -not (Test-Stamp $npmStamp $dependencyHash)) {
            Write-Host 'Installing interface dependencies (internet access may be required)...'
            try {
                Invoke-CheckedCommand -Executable $npmCommand.Source -Arguments @('install', '--no-audit', '--no-fund')
            } catch {
                throw 'Interface dependency installation failed. Review the output above. Check internet access, Node.js version, and Windows / terminal / npm proxy settings. Correct stale settings, then restart.'
            }
            Set-Content -LiteralPath $npmStamp -Value (Get-DependencyHash) -Encoding ASCII
        }

        $buildStamp = Join-Path $frontendRoot 'dist\.basschart-source.sha256'
        $sourceHash = Get-FrontendSourceHash
        if ($Rebuild -or $Reinstall -or -not (Test-Path -LiteralPath (Join-Path $frontendRoot 'dist\index.html')) -or -not (Test-Path -LiteralPath (Join-Path $frontendRoot 'dist-renderer\score.mjs')) -or -not (Test-Stamp $buildStamp $sourceHash)) {
            Write-Host 'Building the interface...'
            Invoke-CheckedCommand -Executable $npmCommand.Source -Arguments @('run', 'build')
            Set-Content -LiteralPath $buildStamp -Value $sourceHash -Encoding UTF8
        }
        if ($nodeCommand) { Invoke-CheckedCommand -Executable $nodeCommand.Source -Arguments @('scripts/check-pdf.mjs') }
    } finally {
        Pop-Location
    }

    $localUrl = "http://127.0.0.1:$Port"
    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $portProbe.Start() } catch {
        throw "Port $Port is already in use. Close the previous server or run start.ps1 -Port 8001."
    } finally { $portProbe.Stop() }

    if (-not $NoBrowser) {
        $browserJob = Start-Job -ArgumentList $localUrl -ScriptBlock {
            param($Url)
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline) {
                try {
                    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
                    if ($response.StatusCode -eq 200) {
                        Start-Process -FilePath $Url
                        return
                    }
                } catch { }
                Start-Sleep -Milliseconds 500
            }
            Write-Output "Browser did not open automatically. Open $Url manually."
        }
    }

    Write-Host ''
    Write-Host "BassTrace: $localUrl" -ForegroundColor Cyan
    Write-Host 'Keep this window open. Press Ctrl+C to stop the server.'
    Invoke-CheckedCommand -Executable $venvPython -Arguments @('-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', "$Port")
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
        Receive-Job -Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}
