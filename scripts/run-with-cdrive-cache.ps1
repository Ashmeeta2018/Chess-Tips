param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'build')]
  [string]$Mode,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$mirrorRoot = Join-Path $env:LOCALAPPDATA 'ChessTipsMirror'

function Invoke-Robocopy {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Target,
    [Parameter(Mandatory = $true)]
    [string[]]$CopyArgs
  )

  New-Item -ItemType Directory -Path $Target -Force | Out-Null

  & robocopy $Source $Target @CopyArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -gt 7) {
    throw "robocopy failed for '$Source' -> '$Target' with exit code $code"
  }
}

Invoke-Robocopy -Source $projectRoot -Target $mirrorRoot -CopyArgs @(
  '/MIR',
  '/XD',
  'node_modules',
  'dist',
  '.git',
  '.vite-temp',
  '.tmp'
)

$mirrorNodeModules = Join-Path $mirrorRoot 'node_modules'
if (-not (Test-Path $mirrorNodeModules)) {
  Invoke-Robocopy -Source (Join-Path $projectRoot 'node_modules') -Target $mirrorNodeModules -CopyArgs @('/MIR')
}

$viteBin = Join-Path $mirrorNodeModules '.bin\\vite.cmd'
$tscBin = Join-Path $mirrorNodeModules '.bin\\tsc.cmd'

if (-not (Test-Path $viteBin)) {
  throw "Vite binary not found in mirror at $viteBin"
}
if (-not (Test-Path $tscBin)) {
  throw "TypeScript binary not found in mirror at $tscBin"
}

Push-Location $mirrorRoot
try {
  if ($Mode -eq 'dev') {
    & $viteBin @Args
    exit $LASTEXITCODE
  }

  & $tscBin -b
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $viteBin build
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
