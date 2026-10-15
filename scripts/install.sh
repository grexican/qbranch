#!/bin/sh
# One-line install of the native binary (macOS, Linux). No Node needed.
#   curl -fsSL https://raw.githubusercontent.com/$BELT_REPO/main/scripts/install.sh | sh
# Then, in a project:  belt install all --platform claude   (or cursor, codex, gemini, copilot, windsurf)
set -eu
REPO="${BELT_REPO:-OWNER/REPO}"          # set once the GitHub org/brand is chosen
DEST="${BELT_HOME:-$HOME/.belt}"
case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac
name="belt-$os-$arch"
url="https://github.com/$REPO/releases/latest/download/$name.tar.gz"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fsSL "$url" -o "$tmp/belt.tar.gz"
rm -rf "$DEST"; mkdir -p "$DEST"
tar -xzf "$tmp/belt.tar.gz" -C "$DEST" --strip-components=1
chmod +x "$DEST/belt"
mkdir -p "$HOME/.local/bin"; ln -sf "$DEST/belt" "$HOME/.local/bin/belt"
echo "installed: $DEST/belt (linked into ~/.local/bin)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "add ~/.local/bin to your PATH" ;; esac
