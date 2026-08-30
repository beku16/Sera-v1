const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seraDesktop', {
  isDesktop: true,
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Reliable clipboard writes from the renderer. navigator.clipboard is
  // flaky inside Electron (focus/permission quirks), which made the chat
  // copy button silently do nothing — the main-process clipboard module
  // has no such constraints.
  clipboardWrite: (text) => ipcRenderer.invoke('sera-clipboard-write', text),
  // Quit everything: closes this window, stops the server this app spawned
  // (if any) and the speech worker it owns. For users who found the console
  // window intimidating — one button, everything stops.
  quitApp: () => ipcRenderer.invoke('sera-quit'),
  // v1.9.0: support workflows — opens %LOCALAPPDATA%\SERA\logs in Explorer
  // (rotating backend + electron-shell logs, secret-redacted).
  openLogFolder: () => ipcRenderer.invoke('sera-open-log-folder'),
  startLocalSpeech: () => ipcRenderer.invoke('local-speech-start'),
  stopLocalSpeech: () => ipcRenderer.invoke('local-speech-stop'),
  getLocalSpeechState: () => ipcRenderer.invoke('local-speech-state'),
  getAutoStart: () => ipcRenderer.invoke('sera-get-autostart'),
  setAutoStart: (enable) => ipcRenderer.invoke('sera-set-autostart', enable),
  showNotification: (title, body) => ipcRenderer.invoke('sera-show-notification', title, body),
  minimizeToTray: () => ipcRenderer.invoke('sera-minimize-to-tray'),
  onTrayAction: (listener) => {
    const handler = (_event, action) => listener(action);
    ipcRenderer.on('sera-tray-action', handler);
    return () => ipcRenderer.removeListener('sera-tray-action', handler);
  },
  onLocalSpeechTranscript: (listener) => {
    let transcriptCount = 0;
    const handler = (_event, payload) => {
      transcriptCount += 1;
      const enrichedPayload = { ...payload, preloadTranscriptCount: transcriptCount };
      console.log(`[PRELOAD_TRANSCRIPT_COUNT] ${transcriptCount}`);
      listener(enrichedPayload);
    };
    ipcRenderer.on('local-speech-transcript', handler);
    return () => ipcRenderer.removeListener('local-speech-transcript', handler);
  },
  onLocalSpeechStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('local-speech-status', handler);
    return () => ipcRenderer.removeListener('local-speech-status', handler);
  },
  onLocalSpeechError: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('local-speech-error', handler);
    return () => ipcRenderer.removeListener('local-speech-error', handler);
  },
  onLocalSpeechDiagnostic: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('local-speech-diagnostic', handler);
    return () => ipcRenderer.removeListener('local-speech-diagnostic', handler);
  },
});
