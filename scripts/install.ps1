# One-line install of the native binary (Windows). No Node needed.
#   irm https://raw.githubusercontent.com/$env:BELT_REPO/main/scripts/install.ps1 | iex
# Then, in a project:  belt install all --platform claude   (or cursor, codex, gemini, copilot, windsurf)
$ErrorActionPreference = 'Stop'
$repo = if ($env:BELT_REPO) { $env:BELT_REPO } else { 'OWNER/REPO' }   # set once the GitHub org/brand is chosen
$dest = if ($env:BELT_HOME) { $env:BELT_HOME } else { Join-Path $env:USERPROFILE '.belt' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "belt-windows-$arch"
$url = "https://github.com/$repo/releases/latest/download/$name.zip"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("belt-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
Write-Host "downloading $url"
Invoke-WebRequest $url -OutFile (Join-Path $tmp 'belt.zip')
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive (Join-Path $tmp 'belt.zip') -DestinationPath $tmp
Move-Item (Join-Path $tmp $name) $dest
Remove-Item -Recurse -Force $tmp
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dest) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  Write-Host "added $dest to your user PATH (open a new terminal)"
}
Write-Host "installed: $dest\belt.exe"
