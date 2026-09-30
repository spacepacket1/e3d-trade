// PM2 config for the primary e3d-trade instance (the live git-tracked checkout,
// distinct from the isolated treatment/control experiment snapshots -- see
// ecosystem.experiment.config.cjs for those).
module.exports = {
  apps: [
    {
      name: 'e3d-trade-dashboard',
      script: 'node',
      args: 'server.js',
      cwd: '/Users/mini/e3d-trade',
      instances: 1,
      autorestart: true,
      watch: false,
      // portfolio.json has grown to ~64MB (1,844+ trades, each carrying full embedded
      // audit objects -- order_lifecycle/token_risk_scan/simulated_execution -- by design,
      // see reconciliationAccounting.js's closed_trades<->action_history cross-check and
      // signalAttribution.js's direct reads off action_history). Parsing/serializing that
      // every cycle pushed this process well past the old 500M ceiling (observed up to
      // ~1.2GB), so PM2 was restarting it roughly every 5 minutes (confirmed in
      // ~/.pm2/pm2.log: "Process 12 restarted because it exceeds --max-memory-restart").
      // 2G gives real headroom; it does not fix the underlying unbounded growth -- see
      // Sep 2026 notes on a sidecar-evidence or archival refactor as the actual fix.
      max_memory_restart: '2G',
      // pipeline.js runs as its own separately-managed PM2 app below --
      // disable the dashboard's own auto-spawn/recover-on-start behavior so
      // the two never race for the same portfolio.json or port 3000.
      env: { PORT: '3000', AUTO_START_PIPELINE: 'false' },
      error_file: '/Users/mini/e3d-trade/logs/dashboard-error.log',
      out_file: '/Users/mini/e3d-trade/logs/dashboard-out.log',
      time: true
    },
    {
      name: 'e3d-trade-pipeline',
      script: 'node',
      args: 'pipeline.js --loop',
      cwd: '/Users/mini/e3d-trade',
      instances: 1,
      autorestart: true,
      watch: false,
      // Same portfolio.json bloat as e3d-trade-dashboard above -- see that app's comment.
      max_memory_restart: '2G',
      error_file: '/Users/mini/e3d-trade/logs/pipeline-error.log',
      out_file: '/Users/mini/e3d-trade/logs/pipeline-out.log',
      time: true
    }
  ]
};
