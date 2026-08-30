const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the SERA screen picker page (electron/screen-picker.html).
 * The picker runs in its own sandboxed window with contextIsolation, so
 * this is the ONLY API it can reach — three invoke calls, nothing else.
 */
contextBridge.exposeInMainWorld('seraScreenPicker', {
  getSources: () => ipcRenderer.invoke('screen-picker:get-sources'),
  select: (id) => ipcRenderer.invoke('screen-picker:select', id),
  cancel: () => ipcRenderer.invoke('screen-picker:cancel'),
});
