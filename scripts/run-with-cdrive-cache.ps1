param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'build')]
  [string]$Mode,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mirrorRoot = Join-Path $env:LOCALAPPDATA 'ChessTipsMirror'
$excludedProjectDirs = @(
  'node_modules',
  'dist',
  '.git',
  '.vite-temp',
  '.tmp'
)

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

function Sync-ProjectToMirror {
  Invoke-Robocopy -Source $projectRoot -Target $mirrorRoot -CopyArgs (
    @(
      '/MIR',
      '/R:1',
      '/W:1',
      '/XD'
    ) + $excludedProjectDirs
  )
}

Sync-ProjectToMirror

$mirrorNodeModules = Join-Path $mirrorRoot 'node_modules'
if (-not (Test-Path $mirrorNodeModules)) {
  $projectNodeModules = Join-Path $projectRoot 'node_modules'
  if (-not (Test-Path $projectNodeModules)) {
    throw "node_modules not found in project root. Run npm install before using this script."
  }

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

$syncProcess = $null

if ($Mode -eq 'dev') {
  $syncArgs = @(
    $projectRoot,
    $mirrorRoot,
    '/MIR',
    '/R:1',
    '/W:1',
    '/MON:1',
    '/MOT:1',
    '/XD'
  ) + $excludedProjectDirs + @(
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP'
  )

  $syncProcess = Start-Process -FilePath 'robocopy.exe' -ArgumentList $syncArgs -WindowStyle Hidden -PassThru
}

$exitCode = 0

Push-Location $mirrorRoot
try {
  if ($Mode -eq 'dev') {
    & $viteBin @Args
    $exitCode = $LASTEXITCODE
  }
  else {
    & $tscBin -b
    if ($LASTEXITCODE -ne 0) {
      $exitCode = $LASTEXITCODE
    }
    else {
      & $viteBin build
      $buildExitCode = $LASTEXITCODE

      if ($buildExitCode -eq 0) {
        $mirrorDist = Join-Path $mirrorRoot 'dist'
        if (Test-Path $mirrorDist) {
          Invoke-Robocopy -Source $mirrorDist -Target (Join-Path $projectRoot 'dist') -CopyArgs @(
            '/MIR',
            '/R:1',
            '/W:1'
          )
        }
      }

      $exitCode = $buildExitCode
    }
  }
}
finally {
  Pop-Location

  if ($syncProcess -and -not $syncProcess.HasExited) {
    Stop-Process -Id $syncProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

exit $exitCode
