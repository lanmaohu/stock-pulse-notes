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

function writeExecutable(directory: string, name: string, source: string) {
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, `#!/usr/bin/env bash\n${source}\n`);
  fs.chmodSync(filename, 0o755);
}

test("deployment shell scripts parse and reject an unsafe application root", () => {
  const syntax = run("bash", ["-n", "scripts/release.sh", "scripts/backup-notes.sh", "deploy/stockpulse.sh"]);
  assert.equal(syntax.status, 0, syntax.stderr);
  const unsafe = run("bash", ["deploy/stockpulse.sh", "status"], { env: { STOCKPULSE_APP_ROOT: "/" } });
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /Unsafe/);
});

test("Xvfb uses a stable working directory across release cleanup", () => {
  const ecosystem = fs.readFileSync(path.join(workspace, "deploy", "ecosystem.config.cjs"), "utf8");
  assert.match(ecosystem, /name: "stockpulse-xvfb",\s+cwd: "\/opt\/stockpulse"/);
});

test("Stockpulse HTTPS uses its own certificate and canonical host", () => {
  const nginx = fs.readFileSync(path.join(workspace, "deploy", "nginx.stockpulse.conf"), "utf8");
  assert.match(nginx, /listen 443 ssl;/);
  assert.match(nginx, /server_name stockpulse\.com\.cn;/);
  assert.match(nginx, /server_name www\.stockpulse\.com\.cn;/);
  assert.match(nginx, /ssl_certificate \/etc\/letsencrypt\/live\/stockpulse\.com\.cn\/fullchain\.pem;/);
  assert.match(nginx, /return 301 https:\/\/stockpulse\.com\.cn\$request_uri;/);
  assert.doesNotMatch(nginx, /pilatesai\.com\.cn/);
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

test("the first versioned deployment atomically creates the current release link", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stockpulse-activate-test-"));
  const releaseId = "release-test";
  const releaseDirectory = path.join(appRoot, "releases", releaseId);
  const binaryDirectory = path.join(appRoot, "bin");
  const pm2Log = path.join(appRoot, "pm2.log");
  fs.mkdirSync(path.join(releaseDirectory, "deploy"), { recursive: true });
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(
    path.join(appRoot, ".env"),
    `PORT=3000\nPLATFORM_BROWSER_EXECUTABLE_PATH=${path.join(binaryDirectory, "chromium")}\n`
  );
  fs.symlinkSync(path.join(appRoot, "current"), path.join(appRoot, "previous"));

  writeExecutable(binaryDirectory, "node", `
if [[ "$1" == "-e" && "$2" == *"process.stdin"* ]]; then echo "test-backup"; fi
if [[ "$1" == *"ops.js" && "$2" == "backup" ]]; then echo '{"backupId":"test-backup"}'; fi
exit 0`);
  writeExecutable(binaryDirectory, "npm", "exit 0");
  writeExecutable(binaryDirectory, "chromium", "exit 0");
  writeExecutable(binaryDirectory, "Xvfb", "exit 0");
  writeExecutable(binaryDirectory, "flock", "exit 0");
  writeExecutable(binaryDirectory, "pm2", `
printf '%s\n' "$*" >> "$PM2_TEST_LOG"
exit 0`);
  writeExecutable(binaryDirectory, "curl", `
url="\${!#}"
if [[ "$url" == *"platform-accounts"* ]]; then printf '401';
elif [[ "$*" == *"%{http_code}"* ]]; then printf '200';
else printf '{}'; fi`);
  writeExecutable(binaryDirectory, "rsync", "exit 0");
  writeExecutable(binaryDirectory, "mv", `
if [[ "$1" == "-Tf" ]]; then /bin/mv -f "$2" "$3"; else /bin/mv "$@"; fi`);

  try {
    const activation = run("bash", [path.join(workspace, "deploy", "stockpulse.sh"), "activate", releaseId], {
      env: { STOCKPULSE_APP_ROOT: appRoot, PM2_TEST_LOG: pm2Log, PATH: `${binaryDirectory}:${process.env.PATH}` }
    });
    assert.equal(activation.status, 0, `${activation.stdout}\n${activation.stderr}`);
    assert.equal(fs.realpathSync(path.join(appRoot, "current")), fs.realpathSync(releaseDirectory));
    assert.equal(fs.lstatSync(path.join(appRoot, "previous"), { throwIfNoEntry: false }), undefined);
    assert.match(fs.readFileSync(pm2Log, "utf8"), /delete stockpulse-worker stockpulse/);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});
