import { spawn, spawnSync } from "node:child_process";

const migration = spawnSync("npm", ["run", "migrate"], { stdio: "inherit", shell: process.platform === "win32" });
if (migration.status !== 0) process.exit(migration.status || 1);

const commands = [
  ["npm", ["run", "dev:api"]],
  ["npm", ["run", "dev:worker"]],
  ["npm", ["run", "dev:client"]]
] as const;

const children = commands.map(([command, args]) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  child.on("exit", (code) => {
    if (code && code > 0) {
      process.exit(code);
    }
  });
  return child;
});

process.on("SIGINT", () => {
  for (const child of children) {
    child.kill("SIGINT");
  }
});
