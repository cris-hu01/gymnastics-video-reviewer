const { spawnSync } = require('node:child_process');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../../../backend');
const buildScript = path.join(backendRoot, 'scripts', 'build_media_tools.py');

const candidates = [];
if (process.env.GYMCLIP_PYTHON) {
  candidates.push([process.env.GYMCLIP_PYTHON, [buildScript]]);
}
if (process.platform === 'win32') {
  candidates.push(['py', ['-3', buildScript]]);
}
candidates.push(['python3', [buildScript]]);
candidates.push(['python', [buildScript]]);

for (const [cmd, args] of candidates) {
  const result = spawnSync(cmd, args, {
    cwd: backendRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    continue;
  }

  if (result.status === 0) {
    process.exit(0);
  }
}

console.error('Failed to bundle ffmpeg tools. Set GYMCLIP_PYTHON if your Python command is non-standard.');
process.exit(1);
