/**
 * Runs `npm audit` at the level CI enforces.
 *
 * `npm run` hands its own settings to the commands it starts as `npm_config_*`
 * variables. Since npm 11.19, an `allow-scripts` setting that arrives that way is
 * treated like a command-line flag and rejected inside a project, so anyone with
 * `allow-scripts` in their user `.npmrc` saw `npm run audit` fail before it
 * audited anything. An audit installs nothing, so the setting is dropped here.
 */

import { spawnSync } from "node:child_process";

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") {
    delete env[key];
  }
}

const result = spawnSync("npm", ["audit", "--audit-level=moderate"], {
  env,
  stdio: "inherit",
  // `npm` is a `.cmd` shim on Windows, which Node only starts through a shell.
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
