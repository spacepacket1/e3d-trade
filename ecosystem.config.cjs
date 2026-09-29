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
      max_memory_restart: '500M',
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
      max_memory_restart: '500M',
      error_file: '/Users/mini/e3d-trade/logs/pipeline-error.log',
      out_file: '/Users/mini/e3d-trade/logs/pipeline-out.log',
      time: true
    }
  ]
};
