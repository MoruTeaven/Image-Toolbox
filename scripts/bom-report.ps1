# scripts/bom-report.ps1
#
# BOM diff report: compares the UTF-8 BOM state of every built dist file against
# the source file it was copied from.
#
# Background: build.ps1 used to read and write with [System.Text.Encoding]::UTF8.
# On PowerShell 5.1 that is an encoder whose GetPreamble() returns the three BOM
# bytes, so every file the alias pass rewrote was emitted with a BOM even though
# the source had none. The result was a dist that could not be compared byte for
# byte against the source, which is exactly what a build-output check needs.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\bom-report.ps1
#
# Exits 0 when dist and source agree on BOM-for-BOM, 1 otherwise.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$distRoot = Join-Path $root "dist"

function Test-HasBom {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 3) { return $false }
        $head = New-Object byte[] 3
        [void]$stream.Read($head, 0, 3)
        return ($head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF)
    } finally {
        $stream.Dispose()
    }
}

# Every extension the build copies around, so the count is not silently limited
# to the .js/.html pair the alias pass happens to touch.
$extensions = @('.js', '.html', '.css', '.json', '.txt', '.md')
$platforms = @('uTools', 'zTools', 'web')

$ok = $true
foreach ($platform in $platforms) {
    $target = Join-Path $distRoot $platform
    if (-not (Test-Path $target)) {
        Write-Host ("  SKIP: dist/{0} does not exist (run build.ps1 first)" -f $platform) -ForegroundColor Yellow
        continue
    }

    # The client folder name differs from the dist folder name only in case.
    $client = switch ($platform) { 'uTools' { 'utools' } 'zTools' { 'ztools' } 'web' { 'web' } }

    $distFiles = Get-ChildItem $target -Recurse -File |
        Where-Object { $extensions -contains $_.Extension }
    $distBom = @($distFiles | Where-Object { Test-HasBom $_.FullName })

    $drift = New-Object System.Collections.Generic.List[string]
    $missing = 0
    foreach ($file in $distFiles) {
        $relative = $file.FullName.Substring($target.Length).TrimStart('\', '/')

        $source = $null
        foreach ($candidate in @(
            (Join-Path $root ("clients\{0}\{1}" -f $client, $relative)),
            (Join-Path $root ("core\src\{0}" -f ($relative -replace '^core\\src\\', '')))
        )) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) { $source = $candidate; break }
        }
        if (-not $source) { $missing++; continue }

        $distHasBom = Test-HasBom $file.FullName
        $srcHasBom = Test-HasBom $source
        if ($distHasBom -ne $srcHasBom) {
            $drift.Add(("{0}: dist BOM={1} source BOM={2}" -f $relative, $distHasBom, $srcHasBom))
        }
    }

    $label = ("dist/{0}" -f $platform)
    if ($drift.Count -eq 0) {
        Write-Host ("  OK: {0} BOM-for-BOM matches the source ({1}/{2} carry a BOM, {3} compared)" -f `
            $label, $distBom.Count, $distFiles.Count, ($distFiles.Count - $missing)) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL: {0} differs from the source in BOM state:" -f $label) -ForegroundColor Red
        $drift | ForEach-Object { Write-Host ("    {0}" -f $_) -ForegroundColor Red }
        $ok = $false
    }
}

if (-not $ok) {
    Write-Host "BOM report: build introduced a BOM difference." -ForegroundColor Red
    exit 1
}

Write-Host "BOM report: dist matches the source." -ForegroundColor Green
