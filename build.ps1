# build.ps1 - Assemble core + clients into dist/<platform>/
# Usage: .\build.ps1
#
# Path strategy:
#   Source uses the location-independent #core/ alias (resolved by the root
#   package.json "imports" field). At build time #core/ is rewritten to the
#   correct relative path for each output file, with the depth computed from
#   the file's actual location in dist instead of being hardcoded per directory.
#
#   dist/<platform>/src/index.html uses paths relative to its own location
#   (e.g. ../core/src/style.css). That is correct for the Electron clients,
#   which load it from .../src/index.html, but wrong for a static web deploy
#   that serves the platform folder as the site root. For the web platform the
#   build therefore additionally emits a site-root index.html with root-relative
#   paths, and Test-WebIndex verifies every referenced file exists.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distRoot = Join-Path $root "dist"
$platforms = @(
    @{ Client = "utools"; Dist = "uTools" },
    @{ Client = "ztools"; Dist = "zTools" },
    @{ Client = "web";   Dist = "web" }
)

# The single text codec this build reads and writes with.
#
# It has to be built explicitly rather than taken from [System.Text.Encoding]::UTF8.
# That property returns an encoder whose GetPreamble() yields EF BB BF, and the
# WriteAllText overloads below honour the preamble - so in Windows PowerShell 5.1
# every file the build rewrote came out with a BOM even when the source had none.
# dist then could not be compared byte for byte against the source, which is the
# one thing a build-output check needs to be able to do.
#
# UTF8Encoding($false) never emits a preamble. Every writer here either replaces
# the contents of a file that already exists or derives its content from a file
# that was copied in unchanged, so the codec can drop the BOM unconditionally:
# a source that carries one keeps it (Copy-Item and xcopy move the bytes as they
# are, never through this codec), and a source that does not gets none.
#
# The decoder is unaffected by the flag - it always strips a leading BOM if one
# is present - so reading is byte-identical either way.
function New-Utf8NoBom {
    return New-Object System.Text.UTF8Encoding($false)
}

# Returns the "./" or "../" prefix a file needs to reach the platform root.
function Get-CorePrefix {
    param(
        [string]$File,
        [string]$TargetRoot,
        [switch]$ForURL
    )

    $dir = Split-Path $File -Parent
    $rel = $dir.Substring($TargetRoot.Length)
    $rel = ($rel -split '[\\/]' | Where-Object { $_ -ne '' }) -join '/'
    $rel = $rel.Trim('/')
    if ([string]::IsNullOrEmpty($rel)) {
        if ($ForURL) {
            # Root-relative prefix: "/" is the site root itself.
            return '/'
        }
        return './'
    }
    if ($ForURL) {
        # Root-relative prefix: either "/" (site root) or walk up one level.
        return ('../' * (Get-RelativeDepth -RelativePath $rel))
    }
    $depth = @($rel.Split('/') | Where-Object { $_ -ne '' }).Count
    return ('../' * $depth)
}

# Number of path segments a relative path walks down.
function Get-RelativeDepth {
    param(
        [string]$RelativePath
    )

    return @($RelativePath.Split('/') | Where-Object { $_ -ne '' }).Count
}

# Rewrites the #core/ alias into a real relative path usable inside dist.
#
# The prefix is derived from each file's own location in dist, never from a
# path prefix that happens to be written in the source. A file that was copied
# to the platform root (e.g. the site-root index.js) therefore gets a different
# prefix than the same file left in src/, and both keep working.
function Update-ImportPaths {
    param([string]$Target)

    $targeted = Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq '.js' -or $_.Extension -eq '.html' }
    foreach ($file in $targeted) {
        $content = [System.IO.File]::ReadAllText($file.FullName, (New-Utf8NoBom))
        if ($content -notlike "*#core/*") {
            continue
        }
        $prefix = Get-CorePrefix -File $file.FullName -TargetRoot $Target
        $newContent = $content.Replace("#core/", ($prefix + "core/src/"))
        if ($newContent -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, (New-Utf8NoBom))
        }
    }
}

# Collects every path this HTML file references at load time.
#   src/href attributes  -> resolved against the HTML file's own directory
#   url(...) inside CSS  -> the referenced resource, resolved the same way
# Data URIs are self-contained and never need a file.
function Get-ReferencedAsset {
    param(
        [string]$Html,
        [string]$HtmlPath,
        [string]$SiteRoot
    )

    $refs = New-Object System.Collections.Generic.List[object]
    $baseDir = Split-Path $HtmlPath -Parent

    foreach ($match in [regex]::Matches($Html, '(?:src|href)\s*=\s*(?:"(?<dq>[^"]*)"|''(?<sq>[^'']*)'')')) {
        $ref = if ($match.Groups['dq'].Success) { $match.Groups['dq'].Value } else { $match.Groups['sq'].Value }
        $refs.Add([pscustomobject]@{ Ref = $ref; Kind = 'attribute' })
    }
    foreach ($match in [regex]::Matches($Html, 'url\(\s*(?:"(?<dq>[^"]*)"|''(?<sq>[^'']*)''|(?<bare>[^)"'']+))\s*\)')) {
        $ref = if ($match.Groups['dq'].Success) { $match.Groups['dq'].Value }
        elseif ($match.Groups['sq'].Success) { $match.Groups['sq'].Value }
        else { $match.Groups['bare'].Value }
        $refs.Add([pscustomobject]@{ Ref = $ref; Kind = 'css-url' })
    }

    $assets = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $refs) {
        $ref = $entry.Ref.Trim()
        if ([string]::IsNullOrEmpty($ref)) { continue }
        if ($ref -match '^(?i)(data:|https?:|mailto:|tel:|javascript:|blob:|//|#)') { continue }
        if ($ref.Contains('$')) { continue }

        $folder = $baseDir
        $clean = $ref.Split('#')[0].Split('?')[0]
        if (-not [string]::IsNullOrEmpty($clean)) {
            if ($clean.StartsWith('/')) {
                # Root-relative: already anchored to the site root.
                $folder = [System.IO.Path]::GetFullPath((Join-Path $SiteRoot $clean.TrimStart('/')))
            } else {
                $folder = [System.IO.Path]::GetFullPath((Join-Path $baseDir $clean))
            }
        }

        # CSS resources (fonts, background images) are loaded by the browser and
        # must exist too; the checker walks them one level deep.
        $kind = 'file'
        if ($clean -match '(?i)\.css$') { $kind = 'css' }
        $assets.Add([pscustomobject]@{ Ref = $ref; Path = $folder; Kind = $kind })
    }

    return $assets
}

# Walks one CSS file and returns the resources it pulls in (fonts, images).
function Get-CssAssetPath {
    param([string]$CssPath)

    $found = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path $CssPath)) { return $found }

    $css = [System.IO.File]::ReadAllText($CssPath, (New-Utf8NoBom))
    $dir = Split-Path $CssPath -Parent
    foreach ($match in [regex]::Matches($css, 'url\(\s*(?:"(?<dq>[^"]*)"|''(?<sq>[^'']*)''|(?<bare>[^)"'']+))\s*\)')) {
        $ref = if ($match.Groups['dq'].Success) { $match.Groups['dq'].Value }
        elseif ($match.Groups['sq'].Success) { $match.Groups['sq'].Value }
        else { $match.Groups['bare'].Value }
        $ref = $ref.Trim()
        if ([string]::IsNullOrEmpty($ref)) { continue }
        if ($ref -match '^(?i)(data:|https?:|blob:|//|#)') { continue }
        $found.Add([System.IO.Path]::GetFullPath((Join-Path $dir $ref.Split('#')[0].Split('?')[0])))
    }
    return $found
}

# Copies a page-local file from dist/<platform>/src/ to the site root of
# dist/<platform>/, where the root page references it from "/".
#
# A copied JS file carries module imports written for its old location. Which
# ones break depends on where they point:
#   "#core/..."            a location-independent alias - always safe, left as is
#   "../core/src/..."      climbs out of dist/web, so from the site root it 404s
#   "./adapters/host/..."  resolved against the site root instead of src/, 404s
# Every subfolder of src/ (adapters/, ...) is mirrored alongside, so an import
# into one only needs the "src/" segment inserted after its "./" or "../".
#
# Paths are repaired by comparing the file's old and new location in dist rather
# than by matching hardcoded names: whatever changes is whatever those two
# locations disagree on, so a new platform or a deeper source tree needs no edit
# here. The result is verified by Test-WebIndex, which loads the entry script and
# asserts every module it imports exists from the site root.
function Copy-WebPageFile {
    param(
        [string]$SourceDir,
        [string]$DestinationDir,
        [string]$Relative
    )

    $source = Join-Path $SourceDir $Relative
    $destination = Join-Path $DestinationDir $Relative
    $destinationParent = Split-Path $destination -Parent
    if (-not (Test-Path -LiteralPath $destinationParent)) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force

    if ([System.IO.Path]::GetExtension($source) -ne '.js') {
        return
    }

    $content = [System.IO.File]::ReadAllText($destination, (New-Utf8NoBom))
    $sourceBase = $SourceDir.TrimEnd('\', '/')
    $destinationBase = $DestinationDir.TrimEnd('\', '/')
    $oldPrefix = ((Split-Path $source -Parent).Substring($sourceBase.Length) -replace '\\', '/').Trim('/')
    $newPrefix = ((Split-Path $destination -Parent).Substring($destinationBase.Length) -replace '\\', '/').Trim('/')

    $fixed = 0
    $content = [regex]::Replace(
        $content,
        '(?<q>["'']'')\.\.?(?<path>/[^"'']*)(?<end>["'']'')',
        {
            param($match)

            $target = Join-Path $oldPrefix $match.Groups['path'].Value.TrimStart('/')
            $target = ($target -replace '\\', '/').Trim('/')
            $relative = [System.IO.Path]::GetRelativePath($newPrefix, $target) -replace '\\', '/'
            if (-not $relative.StartsWith('.')) {
                $relative = "./$relative"
            }
            $script:fixed++
            return $match.Groups['q'].Value + $relative + $match.Groups['end'].Value
        }
    )

    if ($fixed -gt 0) {
        [System.IO.File]::WriteAllText($destination, $content, (New-Utf8NoBom))
        Write-Host "  Repointed $fixed module import(s) in the mirrored $Relative for the site root" -ForegroundColor DarkGray
    }
}

# Returns the files a JS module imports through static ES import statements.
# Bare specifiers (packages) are ignored: everything in dist is a plain file.
function Get-ModuleAsset {
    param(
        [string]$ModulePath,
        [string]$SiteRoot
    )

    $found = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $ModulePath)) { return $found }

    $source = [System.IO.File]::ReadAllText($ModulePath, (New-Utf8NoBom))
    $dir = Split-Path $ModulePath -Parent
    foreach ($match in [regex]::Matches($source, '(?m)^\s*(?:import|export)\b[^;''"]*?from\s*[''"](?<spec>[^''"]+)[''"]')) {
        $spec = $match.Groups['spec'].Value
        if ($spec -notmatch '^\.') { continue }
        $found.Add([System.IO.Path]::GetFullPath((Join-Path $dir $spec)))
    }
    foreach ($match in [regex]::Matches($source, '(?m)^\s*import\s*[''"](?<spec>[^''"]+)[''"]')) {
        $spec = $match.Groups['spec'].Value
        if ($spec -notmatch '^\.') { continue }
        $found.Add([System.IO.Path]::GetFullPath((Join-Path $dir $spec)))
    }

    return $found
}

# Verifies a root-level index.html is genuinely servable from the site root:
# no over-rooting "../" reference, and every referenced asset exists on disk.
function Test-WebIndex {
    param(
        [string]$HtmlPath,
        [string]$SiteRoot,
        [string]$DistName
    )

    $ok = $true
    $label = "dist/$DistName/index.html"

    if (-not (Test-Path $HtmlPath)) {
        Write-Host "  FAIL: $label is missing" -ForegroundColor Red
        return $false
    }

    $html = [System.IO.File]::ReadAllText($HtmlPath, (New-Utf8NoBom))

    # 1. No reference may climb above the site root: from the root, "../x" is a 404.
    $assets = Get-ReferencedAsset -Html $html -HtmlPath $HtmlPath -SiteRoot $SiteRoot
    $overRoot = @()
    foreach ($asset in $assets) {
        if ($asset.Ref -match '^\.\./') { $overRoot += $asset.Ref }
        elseif ($asset.Path -and -not $asset.Path.StartsWith($SiteRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $overRoot += $asset.Ref
        }
    }
    if ($overRoot.Count -gt 0) {
        Write-Host "  FAIL: $label references paths outside the site root (would 404):" -ForegroundColor Red
        $overRoot | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        $ok = $false
    }

    # 2. Every referenced asset must exist.
    $missing = @()
    foreach ($asset in $assets) {
        if ([string]::IsNullOrEmpty($asset.Path) -or -not (Test-Path -LiteralPath $asset.Path)) {
            $missing += $asset.Ref
            continue
        }
        if ($asset.Kind -eq 'css') {
            foreach ($inner in Get-CssAssetPath -CssPath $asset.Path) {
                if (-not (Test-Path $inner)) { $missing += $inner }
            }
        }
    }

    # 2b. Follow the entry script's static ES imports. A page whose <script> tag
    #     resolves can still die on the first import ("./adapters/host/..."),
    #     which a purely HTML-level check cannot see.
    foreach ($entry in ($assets | Where-Object { $_.Kind -eq 'file' -and $_.Path -match '\.js$' })) {
        foreach ($imported in Get-ModuleAsset -ModulePath $entry.Path -SiteRoot $SiteRoot) {
            if (-not (Test-Path -LiteralPath $imported)) {
                $missing += "$($imported.Substring($SiteRoot.Length).TrimStart('\', '/').Replace('\', '/')) (imported by $(Split-Path $entry.Path -Leaf))"
            }
        }
    }

    # 3. Follow the page's own ES module graph. Checking only the HTML attributes
    #    was how a root index.html shipped that 404'd on its very first import:
    #    the script tag resolved, but the modules it pulled in did not. Walking
    #    the imports catches that at build time instead of in the browser.
    $scripts = @($assets | Where-Object { $_.Ref -match '(?i)\.js$' -and (Test-Path -LiteralPath $_.Path) })
    $visited = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $queue = New-Object System.Collections.Generic.Queue[string]
    foreach ($script in $scripts) { $queue.Enqueue($script.Path) }

    while ($queue.Count -gt 0) {
        $file = $queue.Dequeue()
        if (-not $visited.Add($file)) { continue }

        $source = [System.IO.File]::ReadAllText($file, (New-Utf8NoBom))
        # Static imports/exports plus dynamic import() calls. Type-only and bare
        # specifiers are not files in this build, so they are ignored.
        $specifiers = @()
        foreach ($match in [regex]::Matches($source, '(?m)^\s*(?:import|export)\b[^;''"]*?from\s*["''](?<spec>[^"'']+)["'']')) {
            $specifiers += $match.Groups['spec'].Value
        }
        foreach ($match in [regex]::Matches($source, '(?m)^\s*import\s+["''](?<spec>[^"'']+)["'']')) {
            $specifiers += $match.Groups['spec'].Value
        }
        foreach ($match in [regex]::Matches($source, 'import\s*\(\s*["''](?<spec>[^"'']+)["'']\s*\)')) {
            $specifiers += $match.Groups['spec'].Value
        }

        $dir = Split-Path $file -Parent
        foreach ($spec in $specifiers) {
            if ($spec -notmatch '^\.{1,2}/') { continue }
            $resolved = [System.IO.Path]::GetFullPath((Join-Path $dir $spec))
            if ($resolved -match '#core/') { continue }
            if (-not $resolved.StartsWith($SiteRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Host "  FAIL: $label module import climbs out of the site root: $spec (in $file)" -ForegroundColor Red
                $ok = $false
                continue
            }
            if (-not (Test-Path -LiteralPath $resolved)) {
                Write-Host "  FAIL: $label module import is missing from the site root: $spec (in $file)" -ForegroundColor Red
                $ok = $false
                continue
            }
            $queue.Enqueue($resolved)
        }
    }

    if ($missing.Count -gt 0) {
        Write-Host "  FAIL: $label references missing assets:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        $ok = $false
    }

    if ($ok) {
        $listed = ($assets | ForEach-Object { $_.Ref }) -join ', '
        Write-Host "  OK: $label references $($assets.Count) asset(s), all present: $listed" -ForegroundColor DarkGray
        Write-Host "  OK: module graph from the site root is complete ($($visited.Count) script file(s) checked)" -ForegroundColor DarkGray
    }

    return $ok
}

# Builds the site-root index.html for a static web deploy.
#
# The web platform is served with dist/web/ as the document root, so the page
# must be dist/web/index.html with paths that resolve from the root.
#
# This does NOT patch an already-generated product with per-path regular
# expressions: such a patch depends on the exact paths the build happens to
# emit, and when that assumption breaks it silently no-ops while the deploy
# still exits 0. Instead the source page is re-transformed here with the same
# alias rule, and every reference it ends up with is verified against disk.
function New-WebRootIndex {
    param(
        [string]$Target,
        [string]$DistName
    )

    $srcDir = Join-Path $Target "src"
    $srcHtml = Join-Path $srcDir "index.html"
    if (-not (Test-Path $srcHtml)) {
        Write-Host "  FAIL: dist/$DistName/src/index.html is missing" -ForegroundColor Red
        return $false
    }

    # Work from the source page as it was authored, not from the already-rewritten
    # copy in src/: the aliases below are resolved here, against the site root.
    $source = [System.IO.File]::ReadAllText($srcHtml, (New-Utf8NoBom))
    $prefix = Get-CorePrefix -File (Join-Path $Target "index.html") -TargetRoot $Target -ForURL

    # 1. Resolve the location-independent #core/ alias against the document root,
    #    so the page works even if its nested copy sits at a different depth.
    #    Any relative walk generated for the nested copy is dropped first: the
    #    root page never needs to climb out of the site root.
    $content = [regex]::Replace($source, '(?:\.\./)+core/src/', 'core/src/')
    $content = $content.Replace("#core/", "core/src/")

    # 2. Make the page's own local references (index.js, logo.png) root-relative
    #    too, so the page no longer relies on being loaded from a subfolder.
    #    Anchored and negatively checked so the already-root-relative core
    #    references above are left untouched.
    $content = [regex]::Replace(
        $content,
        '(\s(?:src|href)\s*=\s*")(?!\s*(?:[a-zA-Z][a-zA-Z0-9+.\-]*:|//|/|#))(?:\./)?([^"]*")',
        '${1}' + $prefix + '${2}'
    )

    $rootHtml = Join-Path $Target "index.html"
    [System.IO.File]::WriteAllText($rootHtml, $content, (New-Utf8NoBom))

    # 3. Mirror the client's own page-local files (index.js, logo.png, ...) to the
    #    site root, so the references just written above resolve. Anything the
    #    client pulls in that is not one of those files - most notably the
    #    already-root-level core/src/ - is left exactly where it is.
    #
    #    index.js imports the rest of the client through paths such as
    #    "./adapters/host/WebHostAdapter.js", so those sibling directories are
    #    needed next to it at the root too. Copy-WebPageFile mirrors a file and
    #    repoints the imports it carries to the location it actually lands in.
    $clientDirs = @(Get-ChildItem -LiteralPath $srcDir -Directory -ErrorAction SilentlyContinue)

    $missing = @()
    foreach ($asset in (Get-ReferencedAsset -Html $content -HtmlPath $rootHtml -SiteRoot $Target)) {
        if ([string]::IsNullOrEmpty($asset.Path) -or (Test-Path -LiteralPath $asset.Path)) { continue }

        $relative = $asset.Path.Substring($Target.Length).TrimStart('\', '/')

        # Only files that exist in the client's src/ can be mirrored. A reference
        # to anything else must not be silently satisfied by a guess, so it is
        # reported as missing rather than left to 404 on the deployed site.
        if (-not (Test-Path -LiteralPath (Join-Path $srcDir $relative))) {
            $missing += $asset.Ref
            continue
        }

        Copy-WebPageFile -SourceDir $srcDir -DestinationDir $Target -Relative $relative
        Write-Host "  Mirrored src/$relative -> $relative for the site root" -ForegroundColor DarkGray

        # A mirrored page can only resolve imports into directories that were
        # mirrored alongside it; anything else would 404 at runtime.
        foreach ($directory in $clientDirs) {
            $destination = Join-Path $Target $directory.Name
            if (Test-Path -LiteralPath $destination) {
                if ((Get-Item -LiteralPath $destination).PSIsContainer) { continue }
                $missing += "$($directory.Name)/ (a file of that name already occupies the site root)"
                continue
            }
            Copy-Item -LiteralPath $directory.FullName -Destination $destination -Recurse -Force
            Write-Host "  Mirrored src/$($directory.Name)/ -> $($directory.Name)/ for the site root" -ForegroundColor DarkGray
        }

        # Sibling FILES imported by the mirrored page (e.g. src/index.js importing
        # "./imageSourceGuard.js") live in src/ next to it, not in one of the
        # directories copied above, so they need their own mirror pass.
        #
        # The import specifiers are resolved against the SOURCE file's directory
        # (src/index.js), not the mirrored copy, so that "which src/ file does this
        # refer to" stays a simple sibling lookup. Only files sitting directly in
        # src/ are handled here: anything deeper arrived with its parent directory,
        # and core/src/ is intentionally shared at the site root.
        $sourcePage = Join-Path $srcDir $relative
        foreach ($imported in (Get-ModuleAsset -ModulePath $sourcePage -SiteRoot $Target)) {
            if (-not $imported.StartsWith($srcDir, [System.StringComparison]::OrdinalIgnoreCase)) { continue }

            $importedRelative = $imported.Substring($srcDir.Length).TrimStart('\', '/')
            if ($importedRelative -match '[\\/]') { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $srcDir $importedRelative))) { continue }

            $importedTarget = Join-Path $Target $importedRelative
            if (Test-Path -LiteralPath $importedTarget) { continue }

            Copy-WebPageFile -SourceDir $srcDir -DestinationDir $Target -Relative $importedRelative
            Write-Host "  Mirrored src/$importedRelative -> $importedRelative for the site root" -ForegroundColor DarkGray
        }
    }
    if ($missing.Count -gt 0) {
        Write-Host "  FAIL: dist/$DistName/index.html references assets that are neither in" -ForegroundColor Red
        Write-Host "        the site root nor mirrorable from dist/$DistName/src/:" -ForegroundColor Red
        $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        return $false
    }

    # 4. Re-run the alias pass so anything newly mirrored resolves from the site
    #    root as well. It only touches files that still carry the alias, so the
    #    src/ copies and the nested index.js keep the paths for their own depth.
    Update-ImportPaths -Target $Target

    return (Test-WebIndex -HtmlPath $rootHtml -SiteRoot $Target -DistName $DistName)
}

# A root index.html must be regenerated after the alias pass, otherwise the copy
# it was built from is still the pre-rewrite one. The step is idempotent: every
# path it writes is already absolute, so a second run re-derives the same file.
function Test-BuildOutput {
    param(
        [string]$Target,
        [string]$DistName
    )

    $ok = $true
    $checkPaths = @(
        (Join-Path $Target "src\*.js"),
        (Join-Path $Target "src\adapters\host\*.js"),
        (Join-Path $Target "core\src\*.js"),
        (Join-Path $Target "core\src\adapters\*.js"),
        (Join-Path $Target "core\src\app\*.js"),
        (Join-Path $Target "core\src\ui\*.js"),
        (Join-Path $Target "core\src\modules\*.js"),
        (Join-Path $Target "core\src\utils\*.js"),
        (Join-Path $Target "core\src\identity\*.js"),
        (Join-Path $Target "core\src\lib\identity-sdk\*.js"),
        (Join-Path $Target "core\src\lib\identity-sdk\adapters\*.js")
    )

    Get-ChildItem $checkPaths -File -ErrorAction SilentlyContinue | ForEach-Object {
        $result = node --check $_.FullName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  FAIL: $($_.FullName.Replace($Target, "dist/$DistName"))" -ForegroundColor Red
            Write-Host $result -ForegroundColor Red
            $ok = $false
        }
    }

    # The build output must not contain unresolved aliases.
    $leftover = Get-ChildItem $Target -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq '.js' -or $_.Extension -eq '.html' } |
        Select-String -Pattern "#core/" -SimpleMatch -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Host "  FAIL: unresolved #core/ alias in dist/$DistName" -ForegroundColor Red
        $leftover | ForEach-Object { Write-Host "    $($_.Path)" -ForegroundColor Red }
        $ok = $false
    }

    # preload.js is loaded by Electron via CommonJS require(). If an ancestor
    # package.json declares "type": "module", Node rejects it with
    # "require() of ES Module ... not supported" and the plugin fails to load.
    # This guard makes that failure explicit instead of a confusing syntax error.
    $preload = Join-Path $Target "preload.js"
    if (Test-Path $preload) {
        # Walk up from preload.js to the nearest package.json and check its "type".
        $dir = Split-Path $preload -Parent
        $type = $null
        while ($dir -and -not $type) {
            $candidate = Join-Path $dir "package.json"
            if (Test-Path $candidate) {
                $json = [System.IO.File]::ReadAllText($candidate, (New-Utf8NoBom))
                if ($json -match '"type"\s*:\s*"module"') {
                    $type = "module"
                } else {
                    $type = "commonjs"
                }
            }
            $dir = Split-Path $dir -Parent
        }
        if ($type -eq "module") {
            Write-Host "  FAIL: dist/$DistName/preload.js would be treated as an ES module." -ForegroundColor Red
            Write-Host "        Electron requires it as CommonJS, so it would fail to load." -ForegroundColor Red
            Write-Host "        Remove the 'type: module' field from the ancestor package.json." -ForegroundColor Red
            $ok = $false
        }
    }

    return $ok
}


# App version consistency gate (single source of truth: core/src/changelog.js).
# The implementation lives in scripts/version-check.ps1 - it is kept out of this
# file so the heavy CJK comment surface of the docs does not sit inside the
# build script that Windows PowerShell has to tokenize.
. (Join-Path $PSScriptRoot "scripts\version-check.ps1")

# Clean + create
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

# Remove legacy single-target dist output, but keep other platform folders.
foreach ($legacyItem in @('src', 'core', 'plugin.json', 'preload.js', 'logo.png')) {
    $legacyPath = Join-Path $distRoot $legacyItem
    if (Test-Path $legacyPath) { Remove-Item -Recurse -Force $legacyPath }
}

$allOk = $true

foreach ($platform in $platforms) {
    $clientName = $platform.Client
    $distName = $platform.Dist
    $clientRoot = Join-Path $root "clients\$clientName"
    $target = Join-Path $distRoot $distName

    Write-Host "Building dist/$distName/ ..." -ForegroundColor Cyan

    if (-not (Test-Path $clientRoot)) {
        throw "Client not found: $clientRoot"
    }

    if (Test-Path $target) { Remove-Item -Recurse -Force $target }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target "src") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target "core\src") -Force | Out-Null

    # Platform-optional files: plugin.json / preload.js are Electron-only.
    if (Test-Path (Join-Path $clientRoot "plugin.json")) {
        Copy-Item (Join-Path $clientRoot "plugin.json") $target
    }
    if (Test-Path (Join-Path $clientRoot "preload.js")) {
        Copy-Item (Join-Path $clientRoot "preload.js") $target
    }
    Copy-Item (Join-Path $clientRoot "logo.png") $target
    xcopy (Join-Path $clientRoot "src") (Join-Path $target "src\") /E /I /Q /Y | Out-Null
    xcopy (Join-Path $root "core\src") (Join-Path $target "core\src\") /E /I /Q /Y | Out-Null

    # The web platform is deployed as a static site with this folder as the
    # document root, so it needs a root index.html that can resolve every asset
    # from "/" (see New-WebRootIndex).
    #
    # This runs BEFORE the alias pass below, because the root page is built from
    # the src/ copies and those must still carry the location-independent #core/
    # alias: the pass then rewrites src/, core/ and the freshly generated root
    # page each with the prefix its own location in dist needs. It also copies
    # the mirrored entry script, whose module imports are only correct for the
    # site root after that same pass has run, so the ordering is what makes the
    # root page a working one rather than a page that loads a broken module.
    $rootIndexOk = $true
    if ($clientName -eq 'web') {
        Write-Host "Generating site-root index.html for dist/$distName/ ..." -ForegroundColor Cyan
        if (-not (New-WebRootIndex -Target $target -DistName $distName)) {
            $allOk = $false
            $rootIndexOk = $false
        }
    }

    Update-ImportPaths -Target $target

    # Assert the generated root page one last time, after every rewrite: a page
    # that fails here must fail the build instead of deploying with 404s.
    if ($clientName -eq 'web' -and $rootIndexOk) {
        if (-not (Test-WebIndex -HtmlPath (Join-Path $target "index.html") -SiteRoot $target -DistName $distName)) {
            $allOk = $false
        }
    }

    if (Test-BuildOutput -Target $target -DistName $distName) {
        Write-Host "Build complete: dist/$distName/" -ForegroundColor Green
    } else {
        $allOk = $false
    }
}

# App version consistency gate. Runs before anything is produced, so a
# mismatched version can never reach a publishable dist.
Write-Host "Checking app version consistency ..." -ForegroundColor Cyan
if (-not (Test-AppVersion -Root $root -DistRoot $distRoot -Platforms $platforms)) {
    $allOk = $false
}

if (-not $allOk) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Build succeeded." -ForegroundColor Green
