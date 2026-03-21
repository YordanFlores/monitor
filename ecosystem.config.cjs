/** PM2 en Ubuntu: `pm2 start ecosystem.config.cjs` */
module.exports = {
  apps: [
    {
      name: "omnitec-cloud",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
