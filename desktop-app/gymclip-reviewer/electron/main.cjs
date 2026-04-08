const { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = process.env.GYMCLIP_BACKEND_PORT || '8000';
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL || null;
const BACKEND_START_TIMEOUT_MS = Number(process.env.GYMCLIP_BACKEND_START_TIMEOUT_MS || 60000);

let backendProcess = null;

const API_KEY_FILE = 'saved-api-key.bin';
const OSS_CREDENTIALS_FILE = 'saved-oss-credentials.bin';
const APP_SETTINGS_FILE = 'app-settings.json';

function resolveSecureStoreDir() {
  return path.join(app.getPath('userData'), 'secure-store');
}

function resolveApiKeyFile() {
  return path.join(resolveSecureStoreDir(), API_KEY_FILE);
}

function resolveOssCredentialsFile() {
  return path.join(resolveSecureStoreDir(), OSS_CREDENTIALS_FILE);
}

function resolveAppSettingsFile() {
  return path.join(app.getPath('userData'), APP_SETTINGS_FILE);
}

function loadAppSettings() {
  const settingsFile = resolveAppSettingsFile();
  if (!fs.existsSync(settingsFile)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Failed to load app settings', error);
    return {};
  }
}

function saveAppSettings(settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(resolveAppSettingsFile(), JSON.stringify(settings, null, 2), 'utf8');
}

function loadDefaultExportDirectory() {
  const settings = loadAppSettings();
  const defaultExportDirectory =
    typeof settings.defaultExportDirectory === 'string'
      ? settings.defaultExportDirectory.trim()
      : '';
  return {
    defaultExportDirectory: defaultExportDirectory || null,
  };
}

function saveDefaultExportDirectory(defaultExportDirectory) {
  const settings = loadAppSettings();
  const trimmed = String(defaultExportDirectory || '').trim();
  if (trimmed) {
    settings.defaultExportDirectory = trimmed;
  } else {
    delete settings.defaultExportDirectory;
  }
  saveAppSettings(settings);
  return {
    defaultExportDirectory: trimmed || null,
  };
}

function loadUploadSettings() {
  const settings = loadAppSettings();
  const uploadParallelFiles = Number(settings.uploadParallelFiles || 2);
  const uploadPartThreads = Number(settings.uploadPartThreads || 4);
  return {
    uploadParallelFiles: Number.isFinite(uploadParallelFiles) && uploadParallelFiles > 0 ? uploadParallelFiles : 2,
    uploadPartThreads: Number.isFinite(uploadPartThreads) && uploadPartThreads > 0 ? uploadPartThreads : 4,
  };
}

function saveUploadSettings(uploadParallelFiles, uploadPartThreads) {
  const settings = loadAppSettings();
  const parsedParallelFiles = Number(uploadParallelFiles || 2);
  const parsedPartThreads = Number(uploadPartThreads || 4);
  settings.uploadParallelFiles = Number.isFinite(parsedParallelFiles) && parsedParallelFiles > 0 ? parsedParallelFiles : 2;
  settings.uploadPartThreads = Number.isFinite(parsedPartThreads) && parsedPartThreads > 0 ? parsedPartThreads : 4;
  saveAppSettings(settings);
  return {
    uploadParallelFiles: settings.uploadParallelFiles,
    uploadPartThreads: settings.uploadPartThreads,
  };
}

function canUseSecureStorage() {
  return safeStorage.isEncryptionAvailable();
}

function loadSavedApiKey() {
  if (!canUseSecureStorage()) {
    return { supported: false, apiKey: null };
  }

  const apiKeyFile = resolveApiKeyFile();
  if (!fs.existsSync(apiKeyFile)) {
    return { supported: true, apiKey: null };
  }

  try {
    const encrypted = fs.readFileSync(apiKeyFile);
    const apiKey = safeStorage.decryptString(encrypted);
    return { supported: true, apiKey };
  } catch (error) {
    console.error('Failed to load saved API key', error);
    return { supported: true, apiKey: null };
  }
}

function saveApiKey(apiKey) {
  if (!canUseSecureStorage()) {
    return { supported: false };
  }

  const trimmed = String(apiKey || '').trim();
  if (!trimmed) {
    clearSavedApiKey();
    return { supported: true };
  }

  fs.mkdirSync(resolveSecureStoreDir(), { recursive: true });
  const encrypted = safeStorage.encryptString(trimmed);
  fs.writeFileSync(resolveApiKeyFile(), encrypted);
  return { supported: true };
}

function clearSavedApiKey() {
  if (!canUseSecureStorage()) {
    return { supported: false };
  }

  const apiKeyFile = resolveApiKeyFile();
  if (fs.existsSync(apiKeyFile)) {
    fs.rmSync(apiKeyFile, { force: true });
  }
  return { supported: true };
}

function loadSavedOssCredentials() {
  if (!canUseSecureStorage()) {
    return { supported: false, accessKeyId: null, accessKeySecret: null };
  }

  const credentialsFile = resolveOssCredentialsFile();
  if (!fs.existsSync(credentialsFile)) {
    return { supported: true, accessKeyId: null, accessKeySecret: null };
  }

  try {
    const encrypted = fs.readFileSync(credentialsFile);
    const payload = JSON.parse(safeStorage.decryptString(encrypted));
    return {
      supported: true,
      accessKeyId: typeof payload?.accessKeyId === 'string' ? payload.accessKeyId : null,
      accessKeySecret: typeof payload?.accessKeySecret === 'string' ? payload.accessKeySecret : null,
    };
  } catch (error) {
    console.error('Failed to load saved OSS credentials', error);
    return { supported: true, accessKeyId: null, accessKeySecret: null };
  }
}

function saveOssCredentials(accessKeyId, accessKeySecret) {
  if (!canUseSecureStorage()) {
    return { supported: false };
  }

  const trimmedId = String(accessKeyId || '').trim();
  const trimmedSecret = String(accessKeySecret || '').trim();
  if (!trimmedId || !trimmedSecret) {
    clearSavedOssCredentials();
    return { supported: true };
  }

  fs.mkdirSync(resolveSecureStoreDir(), { recursive: true });
  const encrypted = safeStorage.encryptString(
    JSON.stringify({
      accessKeyId: trimmedId,
      accessKeySecret: trimmedSecret,
    }),
  );
  fs.writeFileSync(resolveOssCredentialsFile(), encrypted);
  return { supported: true };
}

function clearSavedOssCredentials() {
  if (!canUseSecureStorage()) {
    return { supported: false };
  }

  const credentialsFile = resolveOssCredentialsFile();
  if (fs.existsSync(credentialsFile)) {
    fs.rmSync(credentialsFile, { force: true });
  }
  return { supported: true };
}

function getDialogOwnerWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function focusPrimaryWindow() {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!window) return;
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
}

function showSystemNotification(payload) {
  const title = String(payload?.title || '').trim();
  const subtitle = String(payload?.subtitle || '').trim();
  const body = String(payload?.body || '').trim();
  if (!title) {
    return { shown: false, reason: 'missing_title' };
  }

  if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) {
    return { shown: false, reason: 'unsupported' };
  }

  const icon = typeof app.dock?.getIcon === 'function' ? app.dock.getIcon() : undefined;
  const notification = new Notification({
    title,
    subtitle,
    body,
    icon,
  });
  notification.on('click', () => {
    focusPrimaryWindow();
  });
  notification.show();
  return { shown: true };
}

const IMPORTABLE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.wmv']);

function isImportableVideoFile(targetPath) {
  const baseName = path.basename(targetPath);
  if (baseName.startsWith('.')) {
    return false;
  }
  return IMPORTABLE_VIDEO_EXTENSIONS.has(path.extname(targetPath).toLowerCase());
}

function collectImportVideoEntries(targetPath, seen, results) {
  let stats = null;
  try {
    stats = fs.statSync(targetPath);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    const children = fs.readdirSync(targetPath, { withFileTypes: true });
    children.forEach((child) => {
      collectImportVideoEntries(path.join(targetPath, child.name), seen, results);
    });
    return;
  }

  if (!stats.isFile() || !isImportableVideoFile(targetPath)) {
    return;
  }

  const resolvedPath = path.resolve(targetPath);
  if (seen.has(resolvedPath)) {
    return;
  }
  seen.add(resolvedPath);
  results.push({
    path: resolvedPath,
    name: path.basename(resolvedPath),
    size: stats.size,
  });
}

async function selectDirectory(initialPath) {
  const storedDefaultDirectory = loadDefaultExportDirectory().defaultExportDirectory;
  const result = await dialog.showOpenDialog(getDialogOwnerWindow() ?? undefined, {
    title: '选择导出目录',
    buttonLabel: '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath:
      typeof initialPath === 'string' && initialPath.trim()
        ? initialPath.trim()
        : storedDefaultDirectory
          ? storedDefaultDirectory
        : app.getPath('documents'),
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}

async function selectImportSources(initialPath) {
  const result = await dialog.showOpenDialog(getDialogOwnerWindow() ?? undefined, {
    title: '选择视频或文件夹',
    buttonLabel: '导入',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    defaultPath:
      typeof initialPath === 'string' && initialPath.trim()
        ? initialPath.trim()
        : app.getPath('documents'),
    filters: [
      {
        name: 'Videos',
        extensions: ['mp4', 'mov', 'mkv', 'avi', 'flv', 'wmv'],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  const seen = new Set();
  const entries = [];
  result.filePaths.forEach((targetPath) => {
    collectImportVideoEntries(targetPath, seen, entries);
  });
  entries.sort((left, right) => left.path.localeCompare(right.path, 'zh-Hans-CN'));
  return entries;
}

function resolveBackendRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend-runtime');
  }
  return path.resolve(__dirname, '../../backend');
}

function resolveMediaToolPath(toolName) {
  if (app.isPackaged) {
    const executableName = process.platform === 'win32' ? `${toolName}.exe` : toolName;
    const packagedPath = path.join(process.resourcesPath, 'media-tools', 'bin', executableName);
    return packagedPath;
  }
  return process.env[`GYMCLIP_${toolName.toUpperCase()}_PATH`] || toolName;
}

function resolveOssToolPath() {
  if (app.isPackaged) {
    const executableName = process.platform === 'win32' ? 'ossutil.exe' : 'ossutil';
    const packagedPath = path.join(process.resourcesPath, 'oss-tools', 'bin', executableName);
    return packagedPath;
  }
  return process.env.GYMCLIP_OSSUTIL_PATH || process.env.GYMCLIP_OSSUTIL_SOURCE || 'ossutil';
}

function resolveBackendCommand() {
  if (app.isPackaged) {
    const executableName = process.platform === 'win32' ? 'gymclip-backend.exe' : 'gymclip-backend';
    const executablePath = path.join(resolveBackendRoot(), 'gymclip-backend', executableName);
    return {
      command: executablePath,
      args: [],
    };
  }

  const backendMain = path.join(resolveBackendRoot(), 'main.py');
  return {
    command: process.env.GYMCLIP_PYTHON || 'python3',
    args: [backendMain],
  };
}

function resolveRendererEntry() {
  return path.resolve(__dirname, '../dist/index.html');
}

function waitForHealth(url, timeoutMs = BACKEND_START_TIMEOUT_MS) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry(new Error(`Backend health returned ${response.statusCode}`));
      });

      request.on('error', retry);
      request.setTimeout(2000, () => {
        request.destroy(new Error('Backend health timed out'));
      });
    };

    const retry = (error) => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(error);
        return;
      }
      setTimeout(attempt, 400);
    };

    attempt();
  });
}

function requestJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const payload = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode ?? 0,
            body: payload ? JSON.parse(payload) : {},
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request to ${url} timed out`));
    });
  });
}

async function ensureBackendCompatibility() {
  const baseUrl = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
  const response = await requestJson(`${baseUrl}/openapi.json`);
  const paths = response.body?.paths ?? {};
  if (!Object.prototype.hasOwnProperty.call(paths, '/api/platform/matches')) {
    throw new Error(
      `检测到旧版 backend 正在占用 ${BACKEND_PORT} 端口。` +
        `请先完全退出残留的 gymclip-backend / Electron 进程后重试。`,
    );
  }
}

async function startBackend() {
  if (backendProcess && backendProcess.exitCode === null) {
    await waitForHealth(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/health`);
    await ensureBackendCompatibility();
    return;
  }

  const backendRoot = resolveBackendRoot();
  const backendWorkspace = path.join(app.getPath('userData'), 'workspace');
  const backendCommand = resolveBackendCommand();

  backendProcess = spawn(backendCommand.command, backendCommand.args, {
    cwd: backendRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      GYMCLIP_BACKEND_ROOT: backendRoot,
      GYMCLIP_BACKEND_HOST: BACKEND_HOST,
      GYMCLIP_BACKEND_PORT: BACKEND_PORT,
      GYMCLIP_BACKEND_RELOAD: '0',
      GYMCLIP_WORKSPACE_ROOT: backendWorkspace,
      GYMCLIP_FFMPEG_PATH: resolveMediaToolPath('ffmpeg'),
      GYMCLIP_FFPROBE_PATH: resolveMediaToolPath('ffprobe'),
      GYMCLIP_OSSUTIL_PATH: resolveOssToolPath(),
    },
  });

  backendProcess.on('exit', (code) => {
    backendProcess = null;
    if (!app.isQuiting) {
      console.error(`Backend exited unexpectedly with code ${code}`);
    }
  });

  await waitForHealth(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/health`);
  await ensureBackendCompatibility();
}

async function createMainWindow() {
  await startBackend();

  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    title: 'GymClip Reviewer',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  if (RENDERER_URL) {
    await window.loadURL(RENDERER_URL);
    return;
  }

  await window.loadFile(resolveRendererEntry());
}

function reportStartupFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to start GymClip Reviewer', error);
  dialog.showErrorBox(
    'GymClip Reviewer 启动失败',
    `应用启动时未能完成初始化。\n\n${message}\n\n请重新安装或联系开发者排查日志。`,
  );
}

function openMainWindow() {
  return createMainWindow().catch((error) => {
    reportStartupFailure(error);
    app.quit();
  });
}

ipcMain.handle('settings:load-api-key', () => loadSavedApiKey());
ipcMain.handle('settings:save-api-key', (_event, apiKey) => saveApiKey(apiKey));
ipcMain.handle('settings:clear-api-key', () => clearSavedApiKey());
ipcMain.handle('settings:load-oss-credentials', () => loadSavedOssCredentials());
ipcMain.handle('settings:save-oss-credentials', (_event, accessKeyId, accessKeySecret) => saveOssCredentials(accessKeyId, accessKeySecret));
ipcMain.handle('settings:clear-oss-credentials', () => clearSavedOssCredentials());
ipcMain.handle('settings:load-default-export-directory', () => loadDefaultExportDirectory());
ipcMain.handle('settings:save-default-export-directory', (_event, defaultExportDirectory) => saveDefaultExportDirectory(defaultExportDirectory));
ipcMain.handle('settings:load-upload-settings', () => loadUploadSettings());
ipcMain.handle('settings:save-upload-settings', (_event, uploadParallelFiles, uploadPartThreads) =>
  saveUploadSettings(uploadParallelFiles, uploadPartThreads));
ipcMain.handle('dialog:select-directory', (_event, initialPath) => selectDirectory(initialPath));
ipcMain.handle('dialog:select-import-sources', (_event, initialPath) => selectImportSources(initialPath));
ipcMain.handle('notification:show', (_event, payload) => showSystemNotification(payload));

app.whenReady().then(() => {
  void openMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openMainWindow();
    }
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
