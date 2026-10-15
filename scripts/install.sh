#!/bin/sh
# One-line install of the native binary (macOS, Linux). No Node needed.
#   curl -fsSL https://raw.githubusercontent.com/$QBRANCH_REPO/main/scripts/install.sh | sh
# Then, in a project:  qbranch install all --platform claude   (or cursor, codex, gemini, copilot, windsurf)
set -eu
REPO="${QBRANCH_REPO:-OWNER/REPO}"          # set once the GitHub org/brand is chosen
DEST="${QBRANCH_HOME:-$HOME/.qbranch}"
case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac
name="qbranch-$os-$arch"
url="https://github.com/$REPO/releases/latest/download/$name.tar.gz"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fsSL "$url" -o "$tmp/qbranch.tar.gz"
rm -rf "$DEST"; mkdir -p "$DEST"
tar -xzf "$tmp/qbranch.tar.gz" -C "$DEST" --strip-components=1
chmod +x "$DEST/qbranch"
mkdir -p "$HOME/.local/bin"; ln -sf "$DEST/qbranch" "$HOME/.local/bin/qbranch"
echo "installed: $DEST/qbranch (linked into ~/.local/bin)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "add ~/.local/bin to your PATH" ;; esac
