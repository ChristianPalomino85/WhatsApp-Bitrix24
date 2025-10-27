module.exports = {
  apps: [
    { name: "wsp-campaigns-api", script: "src/server.js", env: { NODE_ENV: "production" } },
    { name: "wsp-campaigns-worker", script: "src/worker.js", env: { NODE_ENV: "production" } }
  ]
};
