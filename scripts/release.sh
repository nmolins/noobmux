#!/usr/bin/env bash
# Release script for noobmux.
#
# Workflow:
#   1. (optional) bump version in package.json / tauri.conf.json / Cargo.toml
#   2. commit the bump, create tag vX.Y.Z, push commit+tag to origin
#   3. build .deb (release)
#   4. fix Tauri's binary-swap bug, re-sign .deb
#   5. emit latest.json (for the updater endpoint)
#   6. create or update GitHub release with .deb + latest.json
#
# Usage:
#   scripts/release.sh                 # build + draft release for current version
#   scripts/release.sh --publish       # build + publish release (no draft)
#   scripts/release.sh --bump patch    # bump version (patch|minor|major)
#   scripts/release.sh --bump minor --publish
#   scripts/release.sh --skip-git      # skip commit/tag/push (for re-runs)
#
# Requires:
#   - cargo / rust toolchain (~/.cargo/env)
#   - gh authenticated (gh auth status)
#   - $TAURI_SIGNING_PRIVATE_KEY_PATH pointing to ~/.tauri/noobmux.key
#   - Clean working tree (or only the bumped files staged) unless --skip-git

set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=0
BUMP=""
SKIP_GIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --bump) BUMP="$2"; shift 2 ;;
    --skip-git) SKIP_GIT=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Refuse to bump if there are unrelated uncommitted changes (safer).
if [[ -n "$BUMP" && $SKIP_GIT -eq 0 ]]; then
    if [[ -n "$(git status --porcelain | grep -vE '^[ M] (package\.json|src-tauri/(tauri\.conf\.json|Cargo\.(toml|lock)))$' || true)" ]]; then
        echo "ERROR: working tree has unrelated uncommitted changes. Commit or stash them first." >&2
        git status --short >&2
        exit 1
    fi
fi

# ── 1. Bump version (optional) ───────────────────────────────────────────────
if [[ -n "$BUMP" ]]; then
    case "$BUMP" in
        patch|minor|major) ;;
        *) echo "--bump must be patch|minor|major" >&2; exit 2 ;;
    esac
    pnpm version "$BUMP" --no-git-tag-version >/dev/null
    VERSION=$(node -p "require('./package.json').version")
    node -e "const f='src-tauri/tauri.conf.json';const c=require('./'+f);c.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n');"
    sed -i.bak -E "0,/^version = .*/s//version = \"$VERSION\"/" src-tauri/Cargo.toml
    rm -f src-tauri/Cargo.toml.bak
    # Refresh Cargo.lock for the new version.
    (cd src-tauri && cargo update -p noobmux --quiet 2>/dev/null || true)
    echo "→ Bumped to $VERSION"
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

# ── 2. Commit + tag + push ──────────────────────────────────────────────────
if [[ $SKIP_GIT -eq 0 ]]; then
    if [[ -n "$BUMP" ]]; then
        git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
        if ! git diff --cached --quiet; then
            git commit -m "Bump version to $VERSION"
        fi
    fi
    if git rev-parse "$TAG" >/dev/null 2>&1; then
        echo "→ Tag $TAG already exists locally, skipping tag creation"
    else
        git tag -a "$TAG" -m "Release $TAG"
        echo "→ Created tag $TAG"
    fi
    git push --follow-tags
    echo "→ Pushed commit + tag to origin"
fi

echo "→ Building release $TAG"

# ── 3. Build .deb ───────────────────────────────────────────────────────────
source "$HOME/.cargo/env"
export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/noobmux.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
    echo "ERROR: signing key not found at $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
    exit 1
fi

# tauri build needs the key content for the updater artifact signature.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"

rm -rf src-tauri/target/release/bundle
pnpm tauri build --bundles deb

DEB_PATH="src-tauri/target/release/bundle/deb/noobmux_${VERSION}_amd64.deb"
SIG_PATH="${DEB_PATH}.sig"

# ── 4. Fix Tauri's binary-swap bug ──────────────────────────────────────────
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

# ── 5. Re-sign the (possibly swapped) .deb ──────────────────────────────────
echo "→ Signing $DEB_PATH"
pnpm tauri signer sign "$DEB_PATH" \
    --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
    --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" >/dev/null
if [[ ! -f "$SIG_PATH" ]]; then
    echo "ERROR: signature file not found at $SIG_PATH" >&2
    exit 1
fi
SIGNATURE=$(cat "$SIG_PATH")

# ── 6. Build latest.json ────────────────────────────────────────────────────
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

# ── 7. Create / publish GitHub release ──────────────────────────────────────
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
