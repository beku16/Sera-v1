<#
.SYNOPSIS
  SERA One-Command Production Build Pipeline (Windows)
  
.DESCRIPTION
  Executes the full production build pipeline for SERA:
    1. Validates Node.js runtime environment
    2. Installs production dependencies
    3. Typecheck (tsc --noEmit)
    4. Runs full automated test suite (vitest)
    5. Builds frontend and server bundle (Vite + esbuild)
    6. Bundles desktop application and native modules
    7. Generates Sera.exe, Sera Installer.exe, and Sera Portable.exe
    8. Performs production smoke verification
#>

param(
  [switch]$SkipTests = $false
)

$ErrorActionPreference = "Stop"
$rootDir = $PSScriptRoot
Set-Location $rootDir

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  S E R A   -   Production Windows Desktop Build Pipeline" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Validate Environment
Write-Host "[1/6] Validating environment..." -ForegroundColor Yellow
$nodeVersion = node -v
$npmVersion = npm -v
Write-Host "      Node.js: $nodeVersion" -ForegroundColor Gray
Write-Host "      npm:     $npmVersion" -ForegroundColor Gray

# 2. Dependencies
Write-Host "[2/6] Verifying dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
  Write-Host "      Installing dependencies..." -ForegroundColor Gray
  npm install
} else {
  Write-Host "      node_modules found." -ForegroundColor Gray
}

# 3. Typecheck
Write-Host "[3/6] Running TypeScript typecheck (lint)..." -ForegroundColor Yellow
npm run lint
if ($LASTEXITCODE -ne 0) {
  Write-Error "Typecheck failed."
  exit $LASTEXITCODE
}
Write-Host "      Typecheck clean (0 errors)." -ForegroundColor Green

# 4. Tests
if (-not $SkipTests) {
  Write-Host "[4/6] Running automated test suite (Vitest)..." -ForegroundColor Yellow
  npm test
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Test suite failed."
    exit $LASTEXITCODE
  }
  Write-Host "      All test suites passed." -ForegroundColor Green
} else {
  Write-Host "[4/6] Skipping tests (-SkipTests specified)." -ForegroundColor Gray
}

# 5. Production Build & Packaging
Write-Host "[5/6] Building and packaging Windows release..." -ForegroundColor Yellow
npm run dist:win
if ($LASTEXITCODE -ne 0) {
  Write-Error "Packaging failed."
  exit $LASTEXITCODE
}

# 6. Verification
Write-Host "[6/6] Verifying release artifacts..." -ForegroundColor Yellow
$releaseFiles = Get-ChildItem -Path "release" -Filter "*.exe"
if ($releaseFiles.Count -eq 0) {
  Write-Error "No .exe artifacts found in release directory."
  exit 1
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  BUILD SUCCESSFUL!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Release Artifacts Generated:" -ForegroundColor Cyan
foreach ($file in $releaseFiles) {
  $sizeMB = [math]::Round($file.Length / 1MB, 2)
  Write-Host "  - $($file.Name) ($sizeMB MB)" -ForegroundColor White
  Write-Host "    Path: $($file.FullName)" -ForegroundColor Gray
}

$unpackedExe = Join-Path $rootDir "release\win-unpacked\Sera.exe"
if (Test-Path $unpackedExe) {
  Write-Host "  - Sera.exe (Standalone Unpacked)" -ForegroundColor White
  Write-Host "    Path: $unpackedExe" -ForegroundColor Gray
}

Write-Host ""
Write-Host "To launch SERA instantly, double-click:" -ForegroundColor Yellow
Write-Host "  $unpackedExe" -ForegroundColor White
Write-Host ""
