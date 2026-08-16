module.exports = {
  apps: [
    {
      name: "stockpulse",
      cwd: "/opt/stockpulse",
      script: "dist-server/server/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      kill_timeout: 10000,
      env: { NODE_ENV: "production" }
    },
    {
      name: "stockpulse-worker",
      cwd: "/opt/stockpulse",
      script: "dist-server/server/worker.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      kill_timeout: 30000,
      env: { NODE_ENV: "production" }
    }
  ]
};
