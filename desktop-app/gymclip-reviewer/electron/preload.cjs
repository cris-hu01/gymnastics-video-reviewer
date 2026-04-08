const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gymclipDesktop', {
  isDesktop: true,
  loadApiKey: () => ipcRenderer.invoke('settings:load-api-key'),
  saveApiKey: (apiKey) => ipcRenderer.invoke('settings:save-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  loadOssCredentials: () => ipcRenderer.invoke('settings:load-oss-credentials'),
  saveOssCredentials: (accessKeyId, accessKeySecret) =>
    ipcRenderer.invoke('settings:save-oss-credentials', accessKeyId, accessKeySecret),
  clearOssCredentials: () => ipcRenderer.invoke('settings:clear-oss-credentials'),
  loadDefaultExportDirectory: () => ipcRenderer.invoke('settings:load-default-export-directory'),
  saveDefaultExportDirectory: (defaultExportDirectory) =>
    ipcRenderer.invoke('settings:save-default-export-directory', defaultExportDirectory),
  loadUploadSettings: () => ipcRenderer.invoke('settings:load-upload-settings'),
  saveUploadSettings: (uploadParallelFiles, uploadPartThreads) =>
    ipcRenderer.invoke('settings:save-upload-settings', uploadParallelFiles, uploadPartThreads),
  selectDirectory: (initialPath) => ipcRenderer.invoke('dialog:select-directory', initialPath),
  selectImportSources: (initialPath) => ipcRenderer.invoke('dialog:select-import-sources', initialPath),
  showSystemNotification: (payload) => ipcRenderer.invoke('notification:show', payload),
});
