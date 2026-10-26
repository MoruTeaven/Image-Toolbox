# scripts/bom-report.ps1
#
# BOM report: asserts that the build introduces no UTF-8 BOM into dist.
#
# Background (three eras of this build):
#
#   1. Pre-esbuild: dist was a near-copy of the source tree and build.ps1
#      rewrote file contents in place. Reading and writing with
#      [System.Text.Encoding]::UTF8 meant that on Windows PowerShell 5.1 (whose
#      UTF8 encoder returns EF BB BF from GetPreamble()) every rewritten file
#      came out with a BOM the source never had, so dist could not be compared
#      byte for byte against the source.
#
#   2. The gate of era 1 compared each dist file with the source file it was
#      copied from. That was correct while dist was a copy tree. It then rotted:
#      once the output became bundles (app.js / preload.js / index.css), those
#      files have no source counterpart, so the comparison silently skipped
#      them - it reported OK while comparing 3 of 5 files on uTools and 0 of 5
#      on web. A gate that can pass by looking at nothing is the failure this
#      rewrite removes.
#
#   3. Current: the build is a Node orchestrator (scripts/build.mjs) and this
#      gate is a standalone byte-level assertion over the whole dist tree. It is
#      deliberately kept in PowerShell only as a reader; nothing here writes.
#
# The invariant that is actually true and checkable: no step of the build writes
# a BOM. esbuild never emits one, fs.writeFileSync/f.copyFileSync carry no
# preamble, and the PowerShell writers that used to add one
# (Out-File -Encoding utf8, [System.Text.Encoding]::UTF8) are gone. Therefore
# every text file in dist must carry 0 BOM, whatever the source tree looks like.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\bom-report.ps1
# Exits 0 when dist carries no BOM anywhere, 1 otherwise.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$distRoot = Join-Path $root "dist"

# Counts the leading BOM repetitions of a file, so a doubled BOM
# (EF BB BF EF BB BF) is visible as count=2 instead of collapsing to yes/no.
function Get-BomCount {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 3) { return 0 }
        $count = 0
        while ($true) {
            $head = New-Object byte[] 3
            $read = $stream.Read($head, 0, 3)
            if ($read -lt 3) { break }
            if ($head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
                $count++
                # Step back two bytes: a second BOM would begin at the third
                # byte of the first, so the next read starts one BOM byte early.
                [void]$stream.Seek(-2, [System.IO.SeekOrigin]::Current)
            } else {
                break
            }
        }
        return $count
    } finally {
        $stream.Dispose()
    }
}

# Every extension a runtime text asset can carry. .log is here because the build
# itself writes dist/security-gate.log: that file used to carry a BOM (written
# by PowerShell's Out-File -Encoding utf8) while this report - which did not
# scan .log - still declared the whole build clean. A gate that never opens the
# file it exists to guard is exactly the failure class this entry prevents.
$extensions = @('.js', '.mjs', '.cjs', '.html', '.css', '.json', '.txt', '.md', '.log')
$platforms = @('uTools', 'zTools', 'web')

$ok = $true
$scannedFiles = 0
$bomFiles = 0

foreach ($platform in $platforms) {
    $target = Join-Path $distRoot $platform
    if (-not (Test-Path $target)) {
        Write-Host ("  SKIP: dist/{0} does not exist (run the build first)" -f $platform) -ForegroundColor Yellow
        continue
    }

    # No source pairing on purpose: every text file the build emitted must be
    # BOM-free, bundle or copy alike. The compared count is part of the report -
    # the old gate hid a 0-of-5 scan behind an OK line.
    $files = @(Get-ChildItem $target -Recurse -File |
        Where-Object { $extensions -contains $_.Extension })
    $withBom = @($files | Where-Object { (Get-BomCount $_.FullName) -ge 1 })

    $scannedFiles += $files.Count
    $bomFiles += $withBom.Count

    $label = ("dist/{0}" -f $platform)
    if ($withBom.Count -eq 0) {
        Write-Host ("  OK: {0} carries no BOM ({1} text file(s) scanned)" -f $label, $files.Count) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL: {0} contains {1} file(s) with a BOM:" -f $label, $withBom.Count) -ForegroundColor Red
        foreach ($file in $withBom) {
            $relative = $file.FullName.Substring($target.Length).TrimStart('\', '/')
            Write-Host ("    {0} (BOM x{1})" -f $relative, (Get-BomCount $file.FullName)) -ForegroundColor Red
        }
        $ok = $false
    }
}

# Files the build writes directly under dist/ rather than into a platform folder.
# dist/security-gate.log lives there, and scanning only the three platform dirs
# would miss it entirely - the same "gate did not open the file" failure it is
# meant to catch, one directory up.
$rootFiles = @(Get-ChildItem $distRoot -File | Where-Object { $extensions -contains $_.Extension })
if ($rootFiles.Count -gt 0) {
    $rootBom = @($rootFiles | Where-Object { (Get-BomCount $_.FullName) -ge 1 })
    $scannedFiles += $rootFiles.Count
    $bomFiles += $rootBom.Count
    if ($rootBom.Count -eq 0) {
        Write-Host ("  OK: dist/ carries no BOM ({0} text file(s) scanned)" -f $rootFiles.Count) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL: dist/ contains {0} file(s) with a BOM:" -f $rootBom.Count) -ForegroundColor Red
        foreach ($file in $rootBom) {
            Write-Host ("    {0} (BOM x{1})" -f $file.Name, (Get-BomCount $file.FullName)) -ForegroundColor Red
        }
        $ok = $false
    }
}

if ($scannedFiles -eq 0) {
    Write-Host "BOM report: nothing to scan - dist is empty (run the build first)." -ForegroundColor Red
    exit 1
}

# Informational only (does not change the exit code): a source file carrying two
# or more BOMs is corruption rather than a style choice, and bundlers strip it
# silently, so it would never surface as a build failure. Source BOM style is a
# separate topic and stays out of scope for this gate.
$sourceRoots = @('core\src', 'clients')
$multiBom = New-Object System.Collections.Generic.List[string]
foreach ($sourceRoot in $sourceRoots) {
    $sourcePath = Join-Path $root $sourceRoot
    if (-not (Test-Path $sourcePath)) { continue }
    foreach ($file in (Get-ChildItem $sourcePath -Recurse -File | Where-Object { $extensions -contains $_.Extension })) {
        if ((Get-BomCount $file.FullName) -ge 2) {
            $multiBom.Add(("{0} (BOM x{1})" -f $file.FullName.Substring($root.Length + 1), (Get-BomCount $file.FullName)))
        }
    }
}
if ($multiBom.Count -gt 0) {
    Write-Host ("  NOTE: {0} source file(s) carry more than one BOM (not a build failure, reported for follow-up):" -f $multiBom.Count) -ForegroundColor Yellow
    foreach ($entry in $multiBom) { Write-Host ("    {0}" -f $entry) -ForegroundColor Yellow }
}

if (-not $ok) {
    Write-Host ("BOM report: build introduced a BOM ({0} of {1} text file(s) affected)." -f $bomFiles, $scannedFiles) -ForegroundColor Red
    exit 1
}

Write-Host ("BOM report: dist carries no BOM ({0} text file(s) scanned across {1} platform(s))." -f $scannedFiles, $platforms.Count) -ForegroundColor Green
exit 0
