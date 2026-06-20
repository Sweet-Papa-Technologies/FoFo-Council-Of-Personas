#!/usr/bin/env bash
# Installs the Council of Personas skill into your PERSONAL skills directory
# (~/.claude/skills) so it's available in every Claude Code session, from any
# working directory. The project copy under .claude/skills/ already works when
# you're inside this repo; this makes it global.
#
# It rewrites the repo-relative `npm run` command into an absolute one so the
# skill runs no matter where Claude is invoked.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/.claude/skills/council-of-personas/SKILL.md"
DEST_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/council-of-personas"

if [[ ! -f "$SRC" ]]; then
  echo "error: cannot find $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Make the command location-independent: `npm run ... council` ->
# `npm --prefix "<repo>" run ... council`.
sed "s|npm run --silent council|npm --prefix \"$REPO\" run --silent council|g" \
  "$SRC" > "$DEST_DIR/SKILL.md"

echo "✓ Installed: $DEST_DIR/SKILL.md"
echo "  Council repo: $REPO"
echo
echo "Restart Claude Code (or start a new session) and try:"
echo "  \"convene the council on whether we should adopt a monorepo\""
