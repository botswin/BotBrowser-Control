const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Profiles
  profiles: {
    getAll: () => ipcRenderer.invoke('profiles:getAll'),
    exportZip: (options) => ipcRenderer.invoke('profiles:exportZip', options),
    importZip: (source) => ipcRenderer.invoke('profiles:importZip', source),
    exportCsv: (options) => ipcRenderer.invoke('profiles:exportCsv', options),
    importCsv: (source) => ipcRenderer.invoke('profiles:importCsv', source),
    create: (data) => ipcRenderer.invoke('profiles:create', data),
    update: (id, updates) => ipcRenderer.invoke('profiles:update', { id, updates }),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    deleteMultiple: (ids) => ipcRenderer.invoke('profiles:deleteMultiple', ids),
    duplicate: (id) => ipcRenderer.invoke('profiles:duplicate', id),
    clearUserData: (id) => ipcRenderer.invoke('profiles:clearUserData', id),
    copyCliCommand: (id) => ipcRenderer.invoke('profiles:copyCliCommand', id),
  },

  // Browser instances
  browser: {
    launch: (profileId, options) => ipcRenderer.invoke('browser:launch', options ? { profileId, ...options } : profileId),
    stop: (profileId) => ipcRenderer.invoke('browser:stop', profileId),
    stopAll: () => ipcRenderer.invoke('browser:stopAll'),
    warmup: (urls, options) => ipcRenderer.invoke('browser:warmup', { urls, ...(options || {}) }),
    getRunning: () => ipcRenderer.invoke('browser:getRunning'),
  },

  // Settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (data) => ipcRenderer.invoke('settings:set', data),
  },

  // Dialogs
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
    selectExecutable: () => ipcRenderer.invoke('dialog:selectExecutable'),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },

  // Shell
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    showItemInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  },

  // Proxy / IP Check
  proxy: {
    checkIp: (proxyServer) => ipcRenderer.invoke('proxy:checkIp', proxyServer),
  },
  proxies: {
    getAll: () => ipcRenderer.invoke('proxies:getAll'),
    save: (proxy) => ipcRenderer.invoke('proxies:save', proxy),
    export: (ids, destination) => ipcRenderer.invoke('proxies:export', ids, destination),
    delete: (id) => ipcRenderer.invoke('proxies:delete', id),
    bulkImport: (text) => ipcRenderer.invoke('proxies:bulkImport', text),
  },

  // Kernel Manager
  kernel: {
    fetchReleases: () => ipcRenderer.invoke('kernel:fetchReleases'),
    getCachedReleases: () => ipcRenderer.invoke('kernel:getCachedReleases'),
    getDir: () => ipcRenderer.invoke('kernel:getDir'),
    getCapabilities: () => ipcRenderer.invoke('kernel:getCapabilities'),
    listInstalled: () => ipcRenderer.invoke('kernel:listInstalled'),
    delete: (version) => ipcRenderer.invoke('kernel:delete', version),
    download: (opts) => ipcRenderer.invoke('kernel:download', opts),
    cancelDownload: (version) => ipcRenderer.invoke('kernel:cancelDownload', version),
  },

  // App / Update checker
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getUpdateCapabilities: () => ipcRenderer.invoke('app:getUpdateCapabilities'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    selectReleaseAsset: (options) => ipcRenderer.invoke('app:selectReleaseAsset', options),
    stageUpdate: (options) => ipcRenderer.invoke('app:stageUpdate', options),
    getStagedUpdate: (version) => ipcRenderer.invoke('app:getStagedUpdate', version),
    cancelStagedUpdate: (version) => ipcRenderer.invoke('app:cancelStagedUpdate', version),
    applyStagedUpdate: (version) => ipcRenderer.invoke('app:applyStagedUpdate', version),
  },

  // Platform info
  platform: process.platform,
  arch: process.arch,

  // Event listeners
  on: (channel, callback) => {
    const validChannels = [
      'navigate', 'action',
      'instance:started', 'instance:stopped', 'instance:error',
      'profile:statusChanged', 'profile:cookiesSaved',
      'kernel:downloadProgress', 'kernel:downloadComplete', 'kernel:downloadError',
      'app:updateAvailable',
    ];
    if (validChannels.includes(channel)) {
      const sub = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  },

  once: (channel, callback) => {
    ipcRenderer.once(channel, (_, ...args) => callback(...args));
  }
});
