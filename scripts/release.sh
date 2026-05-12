#!/usr/bin/env bash
# Release script for noobmux.
#
# Usage:
#   scripts/release.sh                 # build + create draft release for current version
#   scripts/release.sh --publish       # build + publish release
#   scripts/release.sh --bump patch    # bump version (patch|minor|major), build, publish
#
# Requires:
#   - cargo / rust toolchain (via ~/.cargo/env)
#   - gh authenticated (gh auth status)
#   - $TAURI_SIGNING_PRIVATE_KEY_PATH pointing to ~/.tauri/noobmux.key
#   - Repo on GitHub with releases enabled

set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=0
BUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --bump) BUMP="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# 0. Optional version bump.
if [[ -n "$BUMP" ]]; then
  case "$BUMP" in
    patch|minor|major) ;;
    *) echo "--bump must be patch|minor|major" >&2; exit 2 ;;
  esac
  pnpm version "$BUMP" --no-git-tag-version
  # Sync tauri.conf.json version with package.json.
  VERSION=$(node -p "require('./package.json').version")
  node -e "const f='src-tauri/tauri.conf.json';const c=require('./'+f);c.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n');"
  # Sync Cargo.toml too.
  sed -i.bak -E "0,/^version = .*/s//version = \"$VERSION\"/" src-tauri/Cargo.toml
  rm -f src-tauri/Cargo.toml.bak
  echo "→ Bumped to $VERSION"
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
echo "→ Building release $TAG"

# 1. Build .deb.
source "$HOME/.cargo/env"
export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/noobmux.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "ERROR: signing key not found at $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
fi

rm -rf src-tauri/target/release/bundle
pnpm tauri build --bundles deb

DEB_PATH="src-tauri/target/release/bundle/deb/noobmux_${VERSION}_amd64.deb"
SIG_PATH="${DEB_PATH}.sig"

# 2. Tauri sometimes embeds the unpatched binary in the .deb. Force swap.
echo "→ Fixing .deb binary if needed"
RELEASE_HASH=$(md5sum src-tauri/target/release/noobmux | awk '{print $1}')
TMPDIR=$(mktemp -d)
dpkg-deb -R "$DEB_PATH" "$TMPDIR/extracted"
DEB_HASH=$(md5sum "$TMPDIR/extracted/usr/bin/noobmux" | awk '{print $1}')
if [[ "$RELEASE_HASH" != "$DEB_HASH" ]]; then
    cp src-tauri/target/release/noobmux "$TMPDIR/extracted/usr/bin/noobmux"
    dpkg-deb -b "$TMPDIR/extracted" "$DEB_PATH" >/dev/null
    echo "  swapped binary in .deb"
fi
rm -rf "$TMPDIR"

# 3. Tauri's signature is for the unpatched binary. Re-sign the final .deb.
echo "→ Signing $DEB_PATH"
pnpm tauri signer sign "$DEB_PATH" \
    --private-key "$TAURI_SIGNING_PRIVATE_KEY_PATH" \
    --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" > "$SIG_PATH"
SIGNATURE=$(cat "$SIG_PATH")

# 4. Build latest.json.
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOTES="${RELEASE_NOTES:-Release $TAG}"
cat > /tmp/noobmux-latest.json <<EOF
{
  "version": "$VERSION",
  "notes": $(printf '%s' "$NOTES" | python3 -c "import json,sys;print(json.dumps(sys.stdin.read()))"),
  "pub_date": "$DATE",
  "platforms": {
    "linux-x86_64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/nmolins/noobmux/releases/download/$TAG/noobmux_${VERSION}_amd64.deb"
    }
  }
}
EOF
echo "→ Wrote /tmp/noobmux-latest.json"

# 5. Create / publish GitHub release.
if gh release view "$TAG" >/dev/null 2>&1; then
    echo "→ Release $TAG already exists, uploading artifacts (overwrite)"
    gh release upload "$TAG" "$DEB_PATH" /tmp/noobmux-latest.json --clobber
else
    DRAFT_FLAG=$([[ $PUBLISH -eq 0 ]] && echo "--draft" || echo "")
    gh release create "$TAG" \
        --title "$TAG" \
        --notes "$NOTES" \
        $DRAFT_FLAG \
        "$DEB_PATH" \
        /tmp/noobmux-latest.json
fi

if [[ $PUBLISH -eq 1 ]]; then
    gh release edit "$TAG" --draft=false 2>/dev/null || true
    echo "✓ Published $TAG"
else
    echo "✓ Draft release $TAG ready. Edit/publish on https://github.com/nmolins/noobmux/releases"
fi
