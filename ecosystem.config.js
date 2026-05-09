module.exports = {
  apps: [
    {
      name: "hetong",
      script: "app.js",
      env: {
        DB_PATH: "/root/hetong_data/orders.sqlite",
        DATA_DIR: "/root/hetong_data",
        LOG_DIR: "/root/hetong_data",
      },
    },
  ],
};
