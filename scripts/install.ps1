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
Expand-Archive $zip -DestinationPath $tmp
# replace only what the release ships: tool data lives next to it (middleout sign-ins, cached models) and must survive upgrades
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($item in Get-ChildItem (Join-Path $tmp $name)) {
  $target = Join-Path $dest $item.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item $item.FullName $target
}
Remove-Item -Recurse -Force $tmp
# one command per gadget (`middleout login x`, `moneyball scan`) in bin\, apart from the tools' data folders:
# .cmd for PowerShell/cmd, a sh script for Git Bash
$bin = Join-Path $dest 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null
foreach ($tool in 'headjack', 'middleout', 'moneyball', 'groundhog') {
  Set-Content -Encoding ascii -Path (Join-Path $bin "$tool.cmd") -Value "@`"%~dp0..\qbranch.exe`" $tool %*"
  [IO.File]::WriteAllText((Join-Path $bin $tool), "#!/bin/sh`nexec `"`$(dirname `"`$0`")/../qbranch.exe`" $tool `"`$@`"`n")
  # 0.3.1 put the shims in $dest itself, where a file named middleout blocks middleout's data folder
  foreach ($old in (Join-Path $dest $tool), (Join-Path $dest "$tool.cmd")) { if (Test-Path $old -PathType Leaf) { Remove-Item -Force $old } }
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($dir in $dest, $bin) {
  if (($userPath -split ';') -notcontains $dir) {
    $userPath = "$userPath;$dir"
    [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
    Write-Host "added $dir to your user PATH (open a new terminal)"
  }
}
Write-Host "installed: $dest\qbranch.exe"
