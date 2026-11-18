PHOENIX RUNNER
==============
This lets Phoenix (TestOps) use the browser on YOUR computer, so it can test apps that only work on the company network or VPN.
It only connects OUT to Phoenix. Nothing is opened into your network. It can only visit the websites your team allowed.

FIRST TIME (about 5 minutes, needs internet)
  Mac:      double-click  Install.command
            If Mac says it cannot be opened: right-click the file, choose Open, then Open again.
  Windows:  double-click  Install.bat
            If Windows says "protected your PC": click More info, then Run anyway.
  Wait until it says "All set".

EVERY TIME YOU TEST
  1. Connect to the VPN (if your apps need it).
  2. In Phoenix, open "Laptop runners" and click "Get a pairing code". (Only the first time, or after you were un-paired.)
  3. Double-click  Start.command  (Mac)  or  Start.bat  (Windows). Type the pairing code if it asks.
  4. Leave that window open. In Phoenix, open "Live browser", pick "My laptop", type the website address, click "Open browser".
  5. A browser opens on your computer and you see it in Phoenix. Click and type as normal.
  When you are done, close the window to stop.

GOOD TO KNOW
  - Passwords you type stay on your computer. Phoenix does not store them.
  - To remove the pairing from this computer: delete the file  .phoenix-runner.json  in your home folder, and click Revoke in Phoenix.
  - To uninstall: delete this folder.
  - Problems? Send a screenshot of the window to your Phoenix team.
