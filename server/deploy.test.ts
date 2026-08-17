import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const workspace = process.cwd();

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || workspace,
    env: { ...process.env, ...options.env },
    encoding: "utf8"
  });
}

test("deployment shell scripts parse and reject an unsafe application root", () => {
  const syntax = run("bash", ["-n", "scripts/release.sh", "scripts/backup-notes.sh", "deploy/stockpulse.sh"]);
  assert.equal(syntax.status, 0, syntax.stderr);
  const unsafe = run("bash", ["deploy/stockpulse.sh", "status"], { env: { STOCKPULSE_APP_ROOT: "/" } });
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /Unsafe/);
});

test("release dry-run uses a clean Git commit without contacting a server", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-release-test-"));
  fs.mkdirSync(path.join(repository, "scripts"));
  fs.copyFileSync(path.join(workspace, "scripts", "release.sh"), path.join(repository, "scripts", "release.sh"));
  const binaryDirectory = path.join(repository, "bin");
  fs.mkdirSync(binaryDirectory);
  const fakeGit = path.join(binaryDirectory, "git");
  fs.writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$*" == "status --porcelain" ]]; then exit 0; fi
if [[ "$*" == "rev-parse --verify HEAD" ]]; then echo "0123456789abcdef0123456789abcdef01234567"; exit 0; fi
if [[ "$*" == "rev-parse --short=12 HEAD" ]]; then echo "0123456789ab"; exit 0; fi
exit 1
`);
  fs.chmodSync(fakeGit, 0o755);
  const dryRun = run("bash", ["scripts/release.sh", "--dry-run"], {
    cwd: repository,
    env: {
      DEPLOY_TARGET: "deploy@example.com",
      STOCKPULSE_APP_ROOT: "/opt/stockpulse",
      PATH: `${binaryDirectory}:${process.env.PATH}`
    }
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /^release=/m);
  assert.match(dryRun.stdout, /target=deploy@example\.com/);
  assert.match(dryRun.stdout, /remote_directory=\/opt\/stockpulse\/releases\//);
});
