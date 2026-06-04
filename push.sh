#!/bin/bash
# MGE Social Command Center — Universal push script
# Pushes changes to tgraham1710/mge-social-command-center on GitHub
# PAT is read from macOS Keychain (service: mge-dashboard-github-pat)
# Usage: bash push.sh [optional commit message]

set -e

REPO="tgraham1710/mge-social-command-center"
DIR="$(cd "$(dirname "$0")" && pwd)"
MSG="${1:-"chore: update dashboard"}"

# Load PAT from environment variable, then fall back to Keychain
if [ -z "$PAT" ]; then
  PAT=$(security find-generic-password -s "mge-dashboard-github-pat" -w 2>/dev/null)
  if [ -z "$PAT" ]; then
    echo "❌ PAT not found in Keychain. Run:"
    echo "   security add-generic-password -s mge-dashboard-github-pat -a tgraham@mge.com -w YOUR_TOKEN -U"
    exit 1
  fi
  echo "🔑 PAT loaded from Keychain"
else
  echo "🔑 PAT loaded from environment"
fi

# Files to push (add more as needed)
FILES=("server.js" "MGE_Social_Command_Center.html" "pulse.js" "stories.js" "package.json" "render.yaml" "mge_app_logo.png" "push.sh")

push_file() {
  local FILE="$1"
  local LOCAL="$DIR/$FILE"

  if [ ! -f "$LOCAL" ]; then
    echo "⏭️  Skipping $FILE (not found locally)"
    return
  fi

  echo "📡 Checking $FILE..."
  RESPONSE=$(curl -s -H "Authorization: token $PAT" \
    "https://api.github.com/repos/$REPO/contents/$FILE")

  SHA=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)

  TMPFILE=$(mktemp)
  base64 -i "$LOCAL" > "$TMPFILE"

  python3 - "$TMPFILE" "${SHA:-}" "$PAT" "$REPO" "$FILE" "$MSG" << 'PYEOF'
import sys, json, urllib.request, urllib.error

tmpfile, sha, pat, repo, filename, msg = sys.argv[1:]
with open(tmpfile) as f:
    content = f.read().replace('\n','')

api = f"https://api.github.com/repos/{repo}/contents/{filename}"
body = {"message": msg, "content": content}
if sha:
    body["sha"] = sha

payload = json.dumps(body).encode()
req = urllib.request.Request(api, data=payload,
    headers={"Authorization": f"token {pat}", "Content-Type": "application/json"},
    method="PUT")
try:
    with urllib.request.urlopen(req) as r:
        result = json.loads(r.read())
        print(f"  ✅ {filename} → {result['commit']['sha'][:8]}")
except urllib.error.HTTPError as e:
    print(f"  ❌ {filename} failed: {e.code} {e.read().decode()[:100]}")
PYEOF
  rm -f "$TMPFILE"
}

echo "🚀 Pushing to $REPO..."
for FILE in "${FILES[@]}"; do
  push_file "$FILE"
done

echo ""
echo "🚀 Triggering Render deploy..."
DEPLOY_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.render.com/deploy/srv-d7be0pbuibrs739mi54g?key=iRenHUAjLGM")
if [ "$DEPLOY_RESP" = "200" ] || [ "$DEPLOY_RESP" = "201" ]; then
  echo "✅ Render deploy triggered — live in ~2 min at https://mge-social-command-center.onrender.com"
else
  echo "⚠️  Render deploy hook returned HTTP $DEPLOY_RESP — trigger manually at:"
  echo "   https://dashboard.render.com/web/srv-d7be0pbuibrs739mi54g"
fi
