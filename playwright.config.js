const { defineConfig } = require("playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "dist/e2e-playwright-report", open: "never" }]
  ],
  outputDir: "dist/e2e-results",
  use: {
    trace: "retain-on-failure",
    video: "on",
    screenshot: "only-on-failure"
  }
});
