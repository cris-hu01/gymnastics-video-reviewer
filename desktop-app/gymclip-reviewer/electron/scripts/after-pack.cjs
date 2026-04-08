const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    return;
  }

  const result = spawnSync('xattr', ['-cr', appPath], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Failed to clear extended attributes for ${appPath}`);
  }
};
