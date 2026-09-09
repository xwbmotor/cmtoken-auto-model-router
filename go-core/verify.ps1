param([string]$GoExecutable = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$evidenceDir = Join-Path $projectRoot 'data/go-migration'
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
if (-not $GoExecutable) {
    $installedGo = Get-Command go -ErrorAction SilentlyContinue
    if ($installedGo) { $GoExecutable = $installedGo.Source }
    else { $GoExecutable = Join-Path $projectRoot 'data/go-toolchain/go/bin/go.exe' }
}
if (-not (Test-Path -LiteralPath $GoExecutable)) { throw 'Go 1.25+ is required. Install Go or pass -GoExecutable with an existing compiler path.' }
$GoExecutable = (Resolve-Path -LiteralPath $GoExecutable).Path
$previousGoCache = $env:GOCACHE
$previousGoToolchain = $env:GOTOOLCHAIN
function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$LogPath) {
    if ($LogPath) { & $Executable @Arguments 2>&1 | Tee-Object -FilePath $LogPath }
    else { & $Executable @Arguments }
    if ($LASTEXITCODE -ne 0) { throw "Verification failed: $Executable $($Arguments -join ' ') (exit $LASTEXITCODE)" }
}
Push-Location $PSScriptRoot
try {
    $env:GOCACHE = Join-Path $projectRoot 'data/go-build-cache'
    $env:GOTOOLCHAIN = 'local'
    Invoke-Checked $GoExecutable @('version') (Join-Path $evidenceDir 'go-version.log')
    Invoke-Checked $GoExecutable @('vet', './...') (Join-Path $evidenceDir 'go-vet.log')
    Invoke-Checked $GoExecutable @('test', '-v', '-timeout', '60s', './...') (Join-Path $evidenceDir 'go-test.log')
    $binary = Join-Path $evidenceDir 'amr-core.exe'
    Invoke-Checked $GoExecutable @('build', '-trimpath', '-o', $binary, './cmd/amr-core') ''
    Invoke-Checked 'node' @('compat/verify.mjs', '--binary', $binary) ''
    Invoke-Checked 'node' @('compat/verify-analysis.mjs', '--binary', $binary) ''
    Invoke-Checked 'node' @('compat/verify-semantic.mjs', '--binary', $binary) ''
    Invoke-Checked 'node' @('compat/demo.mjs', '--binary', $binary) ''
    Invoke-Checked 'node' @('compat/demo-semantic.mjs', '--binary', $binary) ''
    Write-Output 'Local checks passed. Linux CI additionally runs go test -race; production migration remains disabled.'
} finally {
    $env:GOCACHE = $previousGoCache
    $env:GOTOOLCHAIN = $previousGoToolchain
    Pop-Location
}
