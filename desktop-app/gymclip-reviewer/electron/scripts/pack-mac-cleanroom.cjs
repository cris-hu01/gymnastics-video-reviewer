const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Cleanroom mac packaging is only supported on macOS.');
  }

  const repoRoot = path.resolve(__dirname, '../../..');
  const tempRoot = path.join(os.tmpdir(), 'gymclip-reviewer-cleanroom');
  const tempRepoRoot = path.join(tempRoot, 'desktop-app');
  const tempFrontendRoot = path.join(tempRepoRoot, 'gymclip-reviewer');
  const artifactRoot = path.join(tempFrontendRoot, 'electron-dist');

  fs.mkdirSync(tempRoot, { recursive: true });

  run('rsync', [
    '-a',
    '--delete',
    '--exclude',
    '.git',
    '--exclude',
    'gymclip-reviewer/electron-dist',
    '--exclude',
    'backend/dist',
    '--exclude',
    'backend/build',
    '--exclude',
    'backend/workspace',
    `${repoRoot}/`,
    `${tempRepoRoot}/`,
  ]);

  const electronAppPath = path.join(
    tempFrontendRoot,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
  );
  if (fs.existsSync(electronAppPath)) {
    run('xattr', ['-cr', electronAppPath]);
  }

  run('npm', ['run', 'electron:pack'], {
    cwd: tempFrontendRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });

  console.log(`Cleanroom mac package ready: ${artifactRoot}`);
}

main();
