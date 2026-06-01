const { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { autoUpdater } = require('electron-updater');

// Ensure hardware-accelerated video decode for smooth scrubbing
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-zero-copy');
// Enable VideoToolbox hardware AV1 decode. Chromium ships this OFF by default
// (added M120, needs Apple Silicon M3+). Our competition sources are AV1-in-MP4,
// so without this the renderer falls back to software dav1d → expensive
// frame-accurate seeks → laggy scrub/trim on short clips. H.264 already HW-decodes
// via the switches above, which is why manually-cut H.264 clips scrub smoothly.
app.commandLine.appendSwitch('enable-features', 'VideoToolboxAv1Decoding');

// === Telemetry consent (C-5) ===
// 持久化匿名 UUID + 用户上报开关到 userData/telemetry.json。
// 首次启动会在 whenReady 之后弹原生 dialog；用户选择前不写盘。
// 后端通过 spawn env (GYMCLIP_USER_ID / GYMCLIP_TELEMETRY_ENABLED) 共享同一 user.id。
let _telemetryCache = null;

function _telemetryFilePath() {
  return path.join(app.getPath('userData'), 'telemetry.json');
}

function _loadTelemetry() {
  if (_telemetryCache) return _telemetryCache;
  const filePath = _telemetryFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data && typeof data.userId === 'string' && data.userId.length > 0) {
        _telemetryCache = data;
        return data;
      }
    }
  } catch (e) {
    console.warn('[telemetry] read failed:', e?.message || e);
  }
  return null; // 首次启动或文件损坏
}

function _saveTelemetry(obj) {
  try {
    fs.mkdirSync(path.dirname(_telemetryFilePath()), { recursive: true });
    fs.writeFileSync(_telemetryFilePath(), JSON.stringify(obj, null, 2), 'utf-8');
    _telemetryCache = obj;
  } catch (e) {
    console.error('[telemetry] write failed:', e?.message || e);
  }
}

function _bootstrapTelemetry() {
  // 返回 {userId, telemetryEnabled, consentVersion, decidedAt, firstRun}
  // 注意：本函数不写盘 — 由 consent dialog 决定后再写。
  const cfg = _loadTelemetry();
  if (cfg) {
    return { ...cfg, firstRun: false };
  }
  return {
    userId: crypto.randomUUID(),
    telemetryEnabled: true,
    consentVersion: 1,
    decidedAt: null,
    firstRun: true,
  };
}

function getTelemetryConfig() {
  // 暴露给 IPC / Sentry init / spawn env 使用。
  // 注意：本函数依赖 app.getPath('userData')，必须在 whenReady 之后调用。
  const cfg = _loadTelemetry() || _bootstrapTelemetry();
  return {
    userId: cfg.userId,
    telemetryEnabled: cfg.telemetryEnabled !== false,
  };
}

function setTelemetryConsent(enabled) {
  const cfg = _loadTelemetry() || _bootstrapTelemetry();
  const next = {
    userId: cfg.userId,
    telemetryEnabled: !!enabled,
    consentVersion: 1,
    decidedAt: new Date().toISOString(),
  };
  _saveTelemetry(next);
  // 用户禁用 → 立即停 Sentry（main process）。
  // 用户启用 → 不重新 init（需要重启），避免重复 init 造成异常。
  if (!enabled) {
    try {
      const Sentry = require('@sentry/electron/main');
      if (typeof Sentry.close === 'function') {
        Sentry.close(2000);
      }
      global.__sentryCaptureException = null;
    } catch (_) { /* Sentry 可能没 init，忽略 */ }
  }
  return { userId: next.userId, telemetryEnabled: next.telemetryEnabled };
}

async function _maybeShowConsentDialog() {
  // 仅在首次启动（telemetry.json 不存在或非法）时弹原生 dialog。
  // 必须在 whenReady 之后、Sentry init 之前调用。
  const cfg = _loadTelemetry();
  if (cfg) return; // 已决定过，不再打扰

  let response = 0; // 默认允许
  try {
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: '匿名错误上报',
      message: '开启匿名错误上报？',
      detail:
        'GymClip Reviewer 可以在出错时把异常堆栈和应用版本上报给开发者，帮助快速定位 bug。\n\n' +
        '上报内容不包含：视频文件、文件路径、OSS 密钥、个人信息。\n' +
        '上报匿名 ID 与本设备绑定，不能反查到您。\n\n' +
        '您可以稍后在设置中随时关闭。',
      buttons: ['允许（推荐）', '不允许'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    response = choice.response;
  } catch (e) {
    console.warn('[telemetry] consent dialog failed, default to enabled:', e?.message || e);
  }

  const enabled = response === 0;
  const boot = _bootstrapTelemetry();
  _saveTelemetry({
    userId: boot.userId,
    telemetryEnabled: enabled,
    consentVersion: 1,
    decidedAt: new Date().toISOString(),
  });
}
// === end Telemetry consent ===

// === Sentry error hooks (C-3) ===
// 必须在 app.whenReady() 之前注册，避免启动早期异常丢失。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  if (global.__sentryCaptureException) {
    try { global.__sentryCaptureException(err); } catch (_) {}
  }
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
  console.error('[unhandledRejection]', err);
  if (global.__sentryCaptureException) {
    try { global.__sentryCaptureException(err); } catch (_) {}
  }
});
app.on('render-process-gone', (event, webContents, details) => {
  const err = new Error(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  console.error('[render-process-gone]', details);
  if (global.__sentryCaptureException) {
    try { global.__sentryCaptureException(err); } catch (_) {}
  }
});
app.on('child-process-gone', (event, details) => {
  const err = new Error(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name}`);
  console.error('[child-process-gone]', details);
  if (global.__sentryCaptureException) {
    try { global.__sentryCaptureException(err); } catch (_) {}
  }
});
// === end Sentry hooks ===

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
  // 共享 telemetry config 到 backend：三端 user.id 一致 + 用户禁用时后端不 init Sentry
  const tcfg = getTelemetryConfig();

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
      GYMCLIP_USER_ID: tcfg.userId,
      GYMCLIP_TELEMETRY_ENABLED: tcfg.telemetryEnabled ? '1' : '0',
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

function _initSentryMain() {
  // Sentry init for main process. 必须在 whenReady() 之后调用 — 依赖 telemetry config，
  // 而 telemetry config 又依赖 app.getPath('userData')。
  // 重复调用 idempotent：如果已 init 过，会被 try/catch 兜底。
  try {
    const tcfg = getTelemetryConfig();
    if (!tcfg.telemetryEnabled) {
      console.info('[sentry] electron main: telemetry opt-out, skip init');
      return;
    }
    const { init: initSentryMain, captureException, setUser } = require('@sentry/electron/main');
    const dsn = process.env.SENTRY_DSN_ELECTRON;
    if (!dsn) {
      console.info('[sentry] SENTRY_DSN_ELECTRON empty, skipping init');
      return;
    }
    initSentryMain({
      dsn,
      release: process.env.SENTRY_RELEASE || `gymclip-reviewer@${require('../package.json').version}`,
      environment: process.env.SENTRY_ENVIRONMENT || (app.isPackaged ? 'production' : 'development'),
      // beforeSend 占位：脱敏可能含密钥的字段
      // TODO(C-5): 完善 PII filtering（视频绝对路径、OSS access key 等）
      beforeSend(event) {
        try {
          const json = JSON.stringify(event);
          if (/(accessKey|secret|password|token)/i.test(json)) {
            // 简单粗暴：把所有 vars/extra 中疑似敏感字段值替换为 [Filtered]
            const filter = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              for (const k of Object.keys(obj)) {
                if (/(accessKey|secret|password|token)/i.test(k)) obj[k] = '[Filtered]';
                else if (typeof obj[k] === 'object') filter(obj[k]);
              }
            };
            filter(event);
          }
        } catch (_) { /* 不让脱敏失败影响上报 */ }
        return event;
      },
    });
    setUser({ id: tcfg.userId });
    global.__sentryCaptureException = captureException;
    console.log('[sentry] electron main initialized for user', `${tcfg.userId.slice(0, 8)}...`);
  } catch (e) {
    console.error('[sentry] init failed (degraded gracefully):', e?.message || e);
  }
}

// === Auto-updater (E-5) ===
// 接 electron-updater 到 GitHub Releases（feed 由 package.json build.publish 配置）。
// 仅在 app.isPackaged 时实际检查；开发模式打 log 跳过，避免本地 dirty build 触发更新提示。
function setupAutoUpdater(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed?.()) {
    console.warn('[autoUpdater] mainWindow unavailable, skip setup');
    return;
  }

  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const breadcrumb = (msg, data) => {
    try {
      const Sentry = require('@sentry/electron/main');
      Sentry.addBreadcrumb({ category: 'autoUpdater', message: msg, level: 'info', data });
    } catch (_) { /* Sentry 未 init 时静默 */ }
  };

  const sendToRenderer = (channel, payload) => {
    try {
      if (!mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    } catch (e) {
      console.warn('[autoUpdater] send to renderer failed:', e?.message || e);
    }
  };

  autoUpdater.on('checking-for-update', () => breadcrumb('checking-for-update'));
  autoUpdater.on('update-available', (info) => {
    breadcrumb('update-available', { version: info?.version });
    sendToRenderer('autoUpdater:update-available', info);
  });
  autoUpdater.on('update-not-available', () => breadcrumb('update-not-available'));
  autoUpdater.on('error', (err) => {
    breadcrumb('error', { message: err?.message });
    try { require('@sentry/electron/main').captureException(err); } catch (_) {}
    console.error('[autoUpdater] error:', err?.message || err);
  });
  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('autoUpdater:download-progress', progress);
  });
  autoUpdater.on('update-downloaded', (info) => {
    breadcrumb('update-downloaded', { version: info?.version });
    sendToRenderer('autoUpdater:update-downloaded', info);
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      console.error('[autoUpdater] checkForUpdatesAndNotify failed:', e?.message || e);
    });
  } else {
    console.log('[autoUpdater] skipped in non-packaged build');
  }
}

ipcMain.handle('autoUpdater:quit-and-install', () => {
  autoUpdater.quitAndInstall();
});
// === end Auto-updater ===

ipcMain.handle('telemetry:get-config', () => getTelemetryConfig());
ipcMain.handle('telemetry:set-consent', (_event, enabled) => setTelemetryConsent(enabled));
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

app.whenReady().then(async () => {
  // 1) 首次启动弹 consent dialog；非首次直接读 telemetry.json。
  // 2) Sentry main init —— 必须放在 whenReady 内部（依赖 userData 路径）且在 consent 之后。
  // 3) 进入主窗口流程。
  try {
    await _maybeShowConsentDialog();
  } catch (e) {
    console.warn('[telemetry] consent flow failed:', e?.message || e);
  }
  _initSentryMain();

  void openMainWindow().then(() => {
    // openMainWindow resolves after createMainWindow() finishes (or after the
    // .catch reports startup failure + app.quit). Only wire the updater when
    // a window actually exists — defensive against the failure path.
    const mainWindow = BrowserWindow.getAllWindows()[0] ?? null;
    if (mainWindow) setupAutoUpdater(mainWindow);
  });

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
