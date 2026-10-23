#!/bin/sh
# One-line install of the native binary (macOS, Linux). No Node needed.
#   curl -fsSL https://raw.githubusercontent.com/grexican/qbranch/main/scripts/install.sh | sh
# Then, in a project:  qbranch install all --platform claude   (or cursor, codex, gemini, copilot, windsurf)
# A private repo's release needs auth: with the GitHub CLI signed in (`gh auth login`), the download goes through gh.
set -eu
REPO="${QBRANCH_REPO:-grexican/qbranch}"
DEST="${QBRANCH_HOME:-$HOME/.qbranch}"
case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac
name="qbranch-$os-$arch"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if command -v gh >/dev/null 2>&1; then
  echo "downloading $name.tar.gz from $REPO (latest release, via gh)"
  gh release download --repo "$REPO" --pattern "$name.tar.gz" --output "$tmp/qbranch.tar.gz" --clobber
else
  url="https://github.com/$REPO/releases/latest/download/$name.tar.gz"
  echo "downloading $url"
  curl -fsSL "$url" -o "$tmp/qbranch.tar.gz"
fi
# replace only what the release ships: tool data lives next to it (middleout sign-ins, cached models) and must survive upgrades
mkdir -p "$tmp/x" "$DEST"
tar -xzf "$tmp/qbranch.tar.gz" -C "$tmp/x" --strip-components=1
for item in "$tmp/x"/* "$tmp/x"/.[!.]*; do
  [ -e "$item" ] || continue
  rm -rf "$DEST/$(basename "$item")"; mv "$item" "$DEST/"
done
chmod +x "$DEST/qbranch"
mkdir -p "$HOME/.local/bin"; ln -sf "$DEST/qbranch" "$HOME/.local/bin/qbranch"
# one command per gadget (`middleout login x`, `moneyball scan`)
for tool in headjack middleout moneyball groundhog; do
  printf '#!/bin/sh\nexec "%s/qbranch" %s "$@"\n' "$DEST" "$tool" > "$HOME/.local/bin/$tool"; chmod +x "$HOME/.local/bin/$tool"
done
echo "installed: $DEST/qbranch (linked into ~/.local/bin, with headjack, middleout, moneyball, groundhog)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "add ~/.local/bin to your PATH" ;; esac
