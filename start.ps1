Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"

function Assert-Command {
    param([string]$CommandName)

    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "Required command '$CommandName' was not found in PATH."
    }
}

Assert-Command -CommandName "npm"
Assert-Command -CommandName "cargo"

$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwsh) {
    $shellExe = $pwsh.Source
} else {
    $powershell = Get-Command powershell -ErrorAction SilentlyContinue
    if (-not $powershell) {
        throw "PowerShell executable was not found."
    }
    $shellExe = $powershell.Source
}

$backendCommand = @"
`$Host.UI.RawUI.WindowTitle = 'NeuroSim Backend'
Set-Location '$backendDir'
cargo run
"@

$frontendCommand = @"
`$Host.UI.RawUI.WindowTitle = 'NeuroSim Frontend'
Set-Location '$frontendDir'
if (-not (Test-Path 'node_modules')) {
    npm install
}
npm run dev
"@

Start-Process -FilePath $shellExe -ArgumentList @("-NoExit", "-Command", $backendCommand) | Out-Null
Start-Sleep -Milliseconds 400
Start-Process -FilePath $shellExe -ArgumentList @("-NoExit", "-Command", $frontendCommand) | Out-Null

Write-Host "Started NeuroSim backend and frontend in separate PowerShell windows."
