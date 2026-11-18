# Phoenix Runner downloads

| File | Who it is for |
|---|---|
| `phoenix-runner-0.1.0.zip` | Testers: Mac and Windows installer (no admin rights). Built without a server address, so the tester types it with the pairing code. To pre-fill it: `python3 packaging/build_packages.py --server https://your-phoenix --out dist` |
| `phoenix-runner-chrome-0.1.0.zip` | Stand-alone Chrome extension (load unpacked, or upload to the Chrome Web Store) |
| `phoenix-runner-tab-kit-0.1.0.zip` | Developers: two scripts + `INTEGRATION.md` to add Phoenix Runner as a tab in an existing extension (FrothTestOps recorder) |

Source: `extension/phoenix-runner/`, `runner/`, `packaging/`. Rebuild after any change with `packaging/build_packages.py`.
