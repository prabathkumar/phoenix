#!/bin/bash
# Phoenix Runner: one-time setup for Mac. Downloads Node and a browser INTO THIS FOLDER. No admin password needed. Takes a few minutes.
cd "$(dirname "$0")" || exit 1
echo "Setting up Phoenix Runner. This only has to be done once. Please wait..."
if [ ! -x node/bin/node ]; then
  case "$(uname -m)" in arm64) P=darwin-arm64;; *) P=darwin-x64;; esac
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o sums.txt || { echo "Could not reach nodejs.org. Check your internet or VPN and run this again."; exit 1; }
  LINE=$(grep -E "node-v[0-9.]+-$P\.tar\.gz$" sums.txt | head -1); SUM=${LINE%% *}; FILE=${LINE##* }
  [ -n "$FILE" ] || { echo "Could not find the right Node download."; exit 1; }
  echo "Downloading Node ($FILE)..."
  curl -fL "$BASE/$FILE" -o node.tar.gz || { echo "Download failed."; exit 1; }
  echo "$SUM  node.tar.gz" | shasum -a 256 -c - >/dev/null || { echo "The download did not match its checksum, so it was thrown away. Run this again."; rm -f node.tar.gz; exit 1; }
  mkdir -p node && tar -xzf node.tar.gz -C node --strip-components=1 && rm -f node.tar.gz sums.txt
fi
export PATH="$PWD/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers"
(cd web && npm install --no-audit --no-fund --omit=dev) || { echo "Installing the helper libraries failed."; exit 1; }
(cd web && npx playwright install chromium) || { echo "Installing the browser failed."; exit 1; }
echo
echo "All set. Now double-click Start.command (connect to the VPN first if your apps need it)."
read -r -p "Press Enter to close this window."
