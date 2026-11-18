#!/bin/bash
# Phoenix Runner: start it. Keep this window open while Phoenix uses this computer. Close the window to stop.
cd "$(dirname "$0")" || exit 1
[ -x node/bin/node ] || { echo "Please double-click Install.command first."; read -r -p "Press Enter."; exit 1; }
export PATH="$PWD/node/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" PHOENIX_RUNNER_CONFIG="$HOME/.phoenix-runner.json"
if [ ! -f "$PHOENIX_RUNNER_CONFIG" ]; then
  SERVER=$(head -1 phoenix-server.txt 2>/dev/null)
  [ -n "$SERVER" ] || read -r -p "Phoenix address (for example https://phoenix.yourcompany.com): " SERVER
  echo "In Phoenix, open 'Laptop runners' and click 'Get a pairing code'."
  read -r -p "Pairing code: " CODE
  node runner/phoenix-runner.js pair "$SERVER" "$CODE" || { read -r -p "Pairing failed. Press Enter."; exit 1; }
fi
echo "Phoenix Runner is running. Leave this window open."
node runner/phoenix-runner.js start
