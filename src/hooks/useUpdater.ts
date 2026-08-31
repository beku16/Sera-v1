import { useState, useEffect, useRef, useCallback } from 'react';
import { UpdateState, UpdateStatus, AssistantSettings } from '../types';
import { APP_VERSION } from '../generated/appVersion';

const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  info: {
    hasUpdate: false,
    currentVersion: APP_VERSION,
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    downloadUrl: null,
    assetName: null,
    assetSize: null,
    lastChecked: null,
  },
  progress: {
    bytesDownloaded: 0,
    totalBytes: 0,
    percent: 0,
    speedBytesPerSec: 0,
    etaSeconds: null,
  },
  downloadedFilePath: null,
  errorMessage: null,
  safeToRestart: true,
};

interface UseUpdaterOptions {
  settings: AssistantSettings;
  onUpdateSettings: (partial: Partial<AssistantSettings>) => void;
}

export function useUpdater({ settings, onUpdateSettings }: UseUpdaterOptions) {
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const [isNotificationVisible, setIsNotificationVisible] = useState(false);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasMountedRef = useRef(false);

  // Poll status from backend
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/update/status');
      if (res.ok) {
        const data = (await res.json()) as UpdateState;
        setUpdateState(data);
        return data;
      }
    } catch {
      // Offline / server busy
    }
    return null;
  }, []);

  // Check for updates
  const check = useCallback(
    async (force = false) => {
      try {
        setUpdateState((prev) => ({ ...prev, status: 'checking', errorMessage: null }));
        const res = await fetch('/api/update/check');
        if (res.ok) {
          const data = (await res.json()) as UpdateState;
          setUpdateState(data);

          if (data.info.hasUpdate && data.info.latestVersion) {
            const latest = data.info.latestVersion;
            const now = Date.now();

            // Anti-Spam Check:
            const isSnoozed =
              settings.snoozedUpdateVersion === latest &&
              settings.snoozedUntil &&
              now < settings.snoozedUntil;

            if (!isSnoozed || force) {
              setIsNotificationVisible(true);
            }

            // Auto-download policy if configured
            if (settings.updateBehavior === 'auto_download' && data.status === 'update-available') {
              setUpdateState((prev) => ({ ...prev, status: 'downloading' }));
              void fetch('/api/update/download', { method: 'POST' }).then(async (res) => {
                if (res.ok) {
                  const d = await res.json();
                  if (d.status) setUpdateState(d.status);
                }
              });
            }
          }
          return data;
        }
      } catch (err: any) {
        setUpdateState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: err?.message || 'Unable to reach update server.',
        }));
      }
      return null;
    },
    [settings.snoozedUpdateVersion, settings.snoozedUntil, settings.updateBehavior]
  );

  // Start in-app download
  const download = useCallback(async () => {
    try {
      setUpdateState((prev) => ({ ...prev, status: 'downloading', errorMessage: null }));
      const res = await fetch('/api/update/download', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.status) {
          setUpdateState(data.status);
          if (data.status.status === 'ready-to-install') {
            setIsNotificationVisible(true);
          }
        }
      }
    } catch (err: any) {
      setUpdateState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err?.message || 'Failed to start download',
      }));
    }
  }, []);

  // Cancel download
  const cancel = useCallback(async () => {
    try {
      const res = await fetch('/api/update/cancel', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.status) setUpdateState(data.status);
      }
    } catch {}
  }, []);

  // Install & Restart
  const installAndRestart = useCallback(async () => {
    try {
      setUpdateState((prev) => ({ ...prev, status: 'installing', errorMessage: null }));
      const res = await fetch('/api/update/install', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (!data.success) {
          setUpdateState((prev) => ({
            ...prev,
            status: 'error',
            errorMessage: data.message || 'Installation failed',
          }));
        }
      }
    } catch (err: any) {
      setUpdateState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err?.message || 'Error triggering restart',
      }));
    }
  }, []);

  // Dismiss notification with anti-spam snooze
  const dismissNotification = useCallback(
    (snoozeHours = 24) => {
      setIsNotificationVisible(false);
      if (updateState.info.latestVersion) {
        const snoozedUntil = Date.now() + snoozeHours * 60 * 60 * 1000;
        onUpdateSettings({
          snoozedUpdateVersion: updateState.info.latestVersion,
          snoozedUntil,
        });
      }
    },
    [updateState.info.latestVersion, onUpdateSettings]
  );

  // Background check on startup (non-blocking after 3s)
  useEffect(() => {
    if (hasMountedRef.current) return;
    hasMountedRef.current = true;

    const startupTimer = setTimeout(() => {
      void check();
    }, 3000);

    return () => clearTimeout(startupTimer);
  }, [check]);

  // Polling loop while downloading, verifying, or installing
  useEffect(() => {
    const isActivelyUpdating =
      updateState.status === 'downloading' ||
      updateState.status === 'verifying' ||
      updateState.status === 'installing';

    if (isActivelyUpdating) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(async () => {
          const fresh = await fetchStatus();
          if (fresh && fresh.status === 'ready-to-install') {
            setIsNotificationVisible(true);
          }
        }, 400);
      }
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [updateState.status, fetchStatus]);

  return {
    updateState,
    isNotificationVisible,
    check,
    download,
    cancel,
    installAndRestart,
    dismissNotification,
    setIsNotificationVisible,
  };
}
