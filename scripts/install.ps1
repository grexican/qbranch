# One-line install of the native binary (Windows). No Node needed.
#   irm https://raw.githubusercontent.com/grexican/qbranch/main/scripts/install.ps1 | iex
# Then, in a project:  qbranch install all --platform claude   (or cursor, codex, gemini, copilot, windsurf)
# A private repo's release needs auth: with the GitHub CLI signed in (`gh auth login`), the download goes through gh.
$ErrorActionPreference = 'Stop'
$repo = if ($env:QBRANCH_REPO) { $env:QBRANCH_REPO } else { 'grexican/qbranch' }
$dest = if ($env:QBRANCH_HOME) { $env:QBRANCH_HOME } else { Join-Path $env:USERPROFILE '.qbranch' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "qbranch-windows-$arch"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("qbranch-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
$zip = Join-Path $tmp 'qbranch.zip'
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Write-Host "downloading $name.zip from $repo (latest release, via gh)"
  gh release download --repo $repo --pattern "$name.zip" --output $zip --clobber
  if ($LASTEXITCODE -ne 0) { throw "gh could not download the release (signed in? gh auth status)" }
} else {
  $url = "https://github.com/$repo/releases/latest/download/$name.zip"
  Write-Host "downloading $url"
  Invoke-WebRequest $url -OutFile $zip
}
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive $zip -DestinationPath $tmp
Move-Item (Join-Path $tmp $name) $dest
Remove-Item -Recurse -Force $tmp
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dest) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  Write-Host "added $dest to your user PATH (open a new terminal)"
}
Write-Host "installed: $dest\qbranch.exe"
