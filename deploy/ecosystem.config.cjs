module.exports = {
  apps: [
    {
      name: "stockpulse",
      cwd: "/opt/stockpulse/current",
      script: "dist-server/server/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 15000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: "300M",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        STOCKPULSE_SERVICE: "api",
        STOCKPULSE_RELEASE: process.env.STOCKPULSE_RELEASE || "development"
      }
    },
    {
      name: "stockpulse-worker",
      cwd: "/opt/stockpulse/current",
      script: "dist-server/server/worker.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      wait_ready: true,
      listen_timeout: 30000,
      kill_timeout: 120000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: "512M",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        STOCKPULSE_SERVICE: "worker",
        STOCKPULSE_RELEASE: process.env.STOCKPULSE_RELEASE || "development"
      }
    }
  ]
};
