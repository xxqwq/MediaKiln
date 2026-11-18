[CmdletBinding()]
param(
  [ValidateSet('', 'patch', 'minor', 'major')]
  [string]$Bump = '',
  [string]$Version = '',
  [switch]$Force,
  [switch]$SkipTests,
  [switch]$AllowDirty,
  [switch]$HotfixOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$tempFiles = @()
$phase = [System.Diagnostics.Stopwatch]::StartNew()
function Complete-Phase([string]$Name) {
  Write-Host ("{0} took {1:N1}s" -f $Name, $phase.Elapsed.TotalSeconds)
  $phase.Restart()
}
try {
  foreach ($cmd in @('git', 'node', 'npm', 'gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
      throw "Required command not found in PATH: $cmd"
    }
  }

  # 0. Inherit Windows system proxy for Go/gh CLI if HTTPS_PROXY is not already set
  if (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY) {
    $inet = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($inet -and $inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
      $proxyVal = [string]$inet.ProxyServer
      if ($proxyVal -notmatch '://') { $proxyVal = "http://$proxyVal" }
      $env:HTTPS_PROXY = $proxyVal
      $env:HTTP_PROXY = $proxyVal
    }
  }

  # 1. Resolve GitHub token (prefer GH_TOKEN, fallback to Git Credential Manager without echoing secrets)
  if (-not $env:GH_TOKEN) {
    $credOut = (node -e "const{execFileSync}=require('child_process');process.stdout.write(execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n'}))")
    $pwLine = ($credOut -split "`r?`n") | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
    if ($pwLine) {
      $env:GH_TOKEN = $pwLine.Substring('password='.Length)
    }
  }

  $ghUserOut = (gh api user --jq .login 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not $ghUserOut) {
    $detail = ($ghUserOut | Out-String).Trim()
    throw "GitHub API/auth check failed: $detail`nCheck your network/proxy or run `"gh auth login`"."
  }
  $ghUser = ($ghUserOut | Select-Object -First 1).ToString().Trim()

  # 2. Resolve canonical GitHub repository (handles renamed repos like videoTool -> usefulTools)
  $originUrl = (git remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $originUrl) { throw 'Failed to read git origin URL.' }
  if ($originUrl -match 'github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$') {
    $rawRepo = $Matches[1]
  } else {
    throw "Cannot parse GitHub repository from origin URL: $originUrl"
  }
  $repoOut = (gh repo view $rawRepo --json nameWithOwner --jq .nameWithOwner 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not $repoOut) {
    $detail = ($repoOut | Out-String).Trim()
    throw "Failed to resolve GitHub repository ($rawRepo): $detail"
  }
  $repo = ($repoOut | Select-Object -First 1).ToString().Trim()

  # 3. Check git working tree
  $dirty = git status --porcelain
  if ($dirty -and -not $AllowDirty) {
    throw "Working tree has uncommitted changes. Commit or stash them first (or pass -AllowDirty)."
  }

  # 4. Optional version bump
  $verTarget = if ($Version) { $Version } elseif ($Bump) { $Bump } else { '' }
  if ($verTarget) {
    if ($DryRun) {
      Write-Host "[DryRun] Would bump version via: npm version $verTarget --no-git-tag-version"
    } else {
      npm version $verTarget --no-git-tag-version
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      $bumpedVer = (node -p "require('./package.json').version").Trim()
      $filesToStage = @('package.json')
      if (Test-Path 'package-lock.json') { $filesToStage += 'package-lock.json' }
      git add $filesToStage
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      git commit -m "chore: release v$bumpedVer"
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }

  # 5. Read package metadata
  $metaJson = node -e "const p=require('./package.json'); console.log(JSON.stringify({version:p.version, portable:(p.build&&p.build.portable&&p.build.portable.artifactName)||'', nsis:(p.build&&p.build.nsis&&p.build.nsis.artifactName)||''}))"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $meta = $metaJson | ConvertFrom-Json
  $ver = $meta.version
  $tag = "v$ver"
  $isPreview = $ver.StartsWith('0.')
  if ($isPreview -and $ver -notmatch '^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Use 0.x.y for a test version. GitHub marks the release as a pre-release.'
  }
  $releaseTitle = if ($isPreview) { "$tag (Beta)" } else { $tag }
  $previewArgs = @()
  if ($isPreview) { $previewArgs = @('--prerelease') }

  Write-Host "Repository : $repo (user: $ghUser)"
  Write-Host "Version    : $releaseTitle"

  # 6. Check if release already exists
  $releaseDraft = gh release view $tag --repo $repo --json isDraft --jq .isDraft 2>$null
  $releaseExists = ($LASTEXITCODE -eq 0)
  if ($releaseExists -and -not $Force) {
    Write-Host "Release $tag already exists on GitHub. Bump version (e.g. npm run release -- -Bump patch) or pass -Force to overwrite."
    exit 0
  }

  if ($DryRun) {
    $distLabel = if ($HotfixOnly) { "build-hotfix (HotfixOnly)" } else { "npm run dist + build-hotfix" }
    Write-Host "[DryRun] Ready to run: ensure-ffmpeg -> smoke-test -> $distLabel -> git push -> upload $tag to $repo (exists=$releaseExists, force=$Force)"
    exit 0
  }
  Complete-Phase 'Release preflight'

  # 7. Ensure FFmpeg binaries exist (needed for smoke tests and full dist)
  if (-not $HotfixOnly -or -not $SkipTests) {
    node scripts/ensure-ffmpeg.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  # 9. Run smoke tests
  if (-not $SkipTests) {
    Write-Host "Running smoke tests..."
    node scripts/smoke-test.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (Test-Path 'scripts/hotfix-test.js') {
      Write-Host "Running hotfix tests..."
      node scripts/hotfix-test.js
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }
  Complete-Phase 'Build and test prerequisites'

  # 10. Build hotfix bundle + optional Windows executables
  Write-Host "Building hotfix bundle..."
  node scripts/build-hotfix.js --repo $repo
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $hotfixBundleName = "hotfix-bundle-$ver.zip"
  $hotfixBundlePath = Join-Path $repoRoot "release\$hotfixBundleName"
  $hotfixManifestPath = Join-Path $repoRoot "release\hotfix-manifest.json"
  if (-not (Test-Path $hotfixBundlePath)) { throw "Built hotfix bundle not found: $hotfixBundlePath" }
  if (-not (Test-Path $hotfixManifestPath)) { throw "Built hotfix manifest not found: $hotfixManifestPath" }
  Complete-Phase 'Hotfix bundle'

  $portableName = $meta.portable.Replace('${version}', $ver)
  $setupName = $meta.nsis.Replace('${version}', $ver)
  $portablePath = Join-Path $repoRoot "release\$portableName"
  $setupPath = Join-Path $repoRoot "release\$setupName"

  if (-not $HotfixOnly) {
    Write-Host "Building Windows executables (npm run dist)..."
    npm run dist
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not (Test-Path $portablePath)) { throw "Built portable exe not found: $portablePath" }
    if (-not (Test-Path $setupPath)) { throw "Built setup exe not found: $setupPath" }

    # Stage ASCII copies so GitHub does not normalize Chinese names into colliding asset filenames
    $portableStage = Join-Path $env:TEMP "video-gif-toolbox-$ver-portable.exe"
    $setupStage = Join-Path $env:TEMP "video-gif-toolbox-$ver-setup.exe"
    Copy-Item $portablePath $portableStage -Force
    Copy-Item $setupPath $setupStage -Force
    $tempFiles += $portableStage, $setupStage
    Complete-Phase 'Windows builds and staging'
  }

  Write-Host "Pushing commits to origin..."
  git push origin HEAD
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $headSha = (git rev-parse HEAD).Trim()
  Complete-Phase 'Git push'

  # Upload all required assets before publishing a new release
  if (-not $releaseExists) {
    Write-Host "Creating draft GitHub Release $tag..."
    gh release create $tag --repo $repo --target $headSha --title "$releaseTitle" --generate-notes --draft @previewArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } else {
    Write-Host "Release $tag already exists; overwriting assets (-Force)..."
  }

  if (-not $HotfixOnly) {
    Write-Host "Uploading portable exe..."
    gh release upload $tag "${portableStage}#${portableName}" --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "Uploading setup exe..."
    gh release upload $tag "${setupStage}#${setupName}" --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }

  Write-Host "Uploading hotfix bundle ($hotfixBundleName)..."
  gh release upload $tag $hotfixBundlePath --repo $repo --clobber
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "Uploading hotfix manifest (hotfix-manifest.json)..."
  gh release upload $tag $hotfixManifestPath --repo $repo --clobber
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $expected = @($hotfixBundlePath, $hotfixManifestPath)
  if (-not $HotfixOnly) { $expected += $portableStage, $setupStage }
  $assetsJson = (gh release view $tag --repo $repo --json assets)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $assets = ($assetsJson | ConvertFrom-Json).assets
  foreach ($filePath in $expected) {
    $file = Get-Item -LiteralPath $filePath
    if (-not ($assets | Where-Object { $_.name -ceq $file.Name -and $_.size -eq $file.Length })) {
      throw "Release asset missing or wrong size: $($file.Name)"
    }
  }
  if (-not $releaseExists -or $releaseDraft -eq 'true') {
    gh release edit $tag --repo $repo --draft=false @previewArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  Complete-Phase 'Upload verification and publication'

  $releaseUrl = (gh release view $tag --repo $repo --json url --jq .url).Trim()
  Write-Host "Release published successfully: $releaseUrl"
} finally {
  foreach ($f in $tempFiles) {
    if ($f -and (Test-Path $f)) {
      Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
  }
  Pop-Location
}
