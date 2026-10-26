# e3d-trade

Node (ESM) crypto trading desk ("e3d-agent-trading-floor"). `pipeline.js` runs the paper-trading loop (scout, harvest, risk, executor); `server.js` is the dashboard; `scripts/` holds the risk engine, custody controls, live executor, reports and the `verify*.js` checks. A live-execution path exists (`scripts/liveExecutor.js`, gated by `LIVE_EXECUTION_ENABLED=1`, caps in `scripts/liveCaps.js`), so treat this repo as able to move real money.

## Hard rules for agent sessions
- Never place, simulate-against-live, or enable real orders. Do not run `pipeline.js`, `npm start`/`loop`, the live executor, or anything that sets `LIVE_EXECUTION_ENABLED`. Do not touch exchanges or wallets.
- Never read, print, copy or commit `.env`, `portfolio.json` (or any `portfolio.json.*` backup), wallet/custody/state files, or anything that looks like a key or token.
- Do not change trading logic, live caps, custody controls or permissions unless the owner asked for exactly that.
- Run verification only through the runner below.

## Verification
`npm run verify:all` (= `node scripts/run-verify.js`) runs the scripts classified as safe offline, one child process each with a timeout (`--timeout-ms=`, `--only=<substr>`), prints a pass/fail table, exits non-zero on any failure, and lists skipped scripts with reasons. Children get a minimal env; on macOS they also run under `sandbox-exec` with network denied (`--no-sandbox` to disable).

Not run by the runner: `verifyLiveExecutorFork.js` and `verifyLivePipelineFork.js` (mainnet fork, `.env`, hot wallet), `verifyMacroCrossAssetClient.js` and `verifyMapsClient.js` (live network). Any new `scripts/verify*.js` shows up as UNCLASSIFIED until added to the lists in `scripts/run-verify.js`. `pipeline.js` reads `.env` on import, so prefer a checkout without one.

## Known issues (owner to decide, not changed here)
- Tracked `.claude/settings.json` sets `permissions.defaultMode` to `bypassPermissions`, so agent sessions in this repo skip permission prompts.
- `node_modules/` is committed to git.
- Some verify scripts fail on main today (see PR for the list).
