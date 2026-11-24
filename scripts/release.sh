#!/usr/bin/env bash
# Cut a LinkCharts release: bump the version, tag it, push it and start the Windows build.
#
#   npm run release -- 1.3.3            # notes come from the "## [1.3.3] …" section of CHANGELOG.md
#   npm run release -- 1.3.3 notes.md   # …or from a file
#   DRY_RUN=1 npm run release -- 1.3.3  # show what would happen, change nothing
#
# The upstream repo (Mehal45/LinkCharts) is read-only for this account, so releases go to the
# "fork" remote. GitHub does not start workflows for tags pushed to a fork, so the build is
# started by hand with `gh workflow run` against the tag.
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:-}"
[ -n "$V" ] || { echo "usage: npm run release -- <version> [notes-file]" >&2; exit 1; }
V="${V#v}"
NOTES_FILE="${2:-}"

fail() { printf '✗ %b\n' "$*" >&2; exit 1; }

# A clean tree, except for the changelog entry you just wrote.
DIRTY="$(git status --porcelain | grep -v '^ M CHANGELOG.md$' || true)"
[ -z "$DIRTY" ] || fail "commit or stash these first:\n$DIRTY"
if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then fail "tag v$V already exists"; fi
command -v gh >/dev/null || fail "GitHub CLI (gh) is required"
git remote get-url fork >/dev/null 2>&1 || fail "no 'fork' remote — the upstream repo is read-only for this account"
REPO="$(git remote get-url fork | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# The tagged commit's message becomes the release notes and the app's "What's new".
TMP=""
if [ -z "$NOTES_FILE" ]; then
  TMP="$(mktemp)"
  awk -v h="## [$V]" 'index($0, h) == 1 { f = 1; next } /^## \[/ { f = 0 } f' CHANGELOG.md > "$TMP"
  NOTES_FILE="$TMP"
  [ -s "$NOTES_FILE" ] || { rm -f "$TMP"; fail "no '## [$V]' section in CHANGELOG.md (or pass a notes file)"; }
fi

echo "→ $V · $REPO · branch $BRANCH"
if [ -n "${DRY_RUN:-}" ]; then
  echo "— dry run: would bump package.json, commit, tag v$V, push $BRANCH + tag, start the build"
  echo "— notes:"; sed 's/^/    /' "$NOTES_FILE"
  [ -n "$TMP" ] && rm -f "$TMP"
  exit 0
fi

npm version "$V" --no-git-tag-version >/dev/null
git add -A
git commit -q -F "$NOTES_FILE"
git tag -a "v$V" -m "LinkCharts $V"
[ -n "$TMP" ] && rm -f "$TMP"

git -c credential.helper='!gh auth git-credential' push -q fork "$BRANCH"
git -c credential.helper='!gh auth git-credential' push -q fork "v$V"
echo "✓ pushed $BRANCH and v$V"

WF="$(gh workflow list --repo "$REPO" --json id,name --jq '.[] | select(.name == "Build installer") | .id')"
[ -n "$WF" ] || fail "workflow 'Build installer' not found in $REPO"
gh workflow run "$WF" --repo "$REPO" --ref "v$V"

RUN=""
for _ in 1 2 3 4 5 6; do
  RUN="$(gh run list --repo "$REPO" --workflow "$WF" --limit 1 --json databaseId --jq '.[0].databaseId')"
  [ -n "$RUN" ] && break
  sleep 2
done
echo "✓ build started: https://github.com/$REPO/actions/runs/$RUN"
echo "  watch:  gh run watch $RUN --repo $REPO"
echo "  verify: gh api repos/$REPO/releases/tags/v$V --jq '.assets[] | {name, size, digest}'"
