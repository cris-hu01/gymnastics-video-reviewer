import {useEffect, useState} from 'react';

type UpdateInfo = {
  version: string;
  releaseNotes?: string;
  releaseName?: string;
};

export function UpdateToast() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const bridge = window.gymclipDesktop;
    if (!bridge?.onUpdateAvailable) return;
    bridge.onUpdateAvailable((info) => setUpdateInfo(info));
    bridge.onDownloadProgress?.((p) => setProgress(p.percent));
    bridge.onUpdateDownloaded?.((info) => {
      setDownloaded(true);
      setUpdateInfo(info);
    });
  }, []);

  if (!updateInfo) return null;

  return (
    <div
      data-testid="update-toast"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        padding: '12px 16px',
        background: '#1f2937',
        color: 'white',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        maxWidth: 320,
      }}
    >
      {downloaded ? (
        <>
          <div>新版本 v{updateInfo.version} 已下载完成</div>
          <button
            data-testid="update-quit-install"
            onClick={() => window.gymclipDesktop?.quitAndInstall?.()}
            style={{
              marginTop: 8,
              padding: '6px 12px',
              background: '#10b981',
              color: 'white',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            重启更新
          </button>
        </>
      ) : (
        <>
          <div>正在下载新版本 v{updateInfo.version}...</div>
          <div
            style={{
              marginTop: 8,
              height: 4,
              background: '#374151',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <div style={{height: '100%', background: '#10b981', width: `${progress}%`}}></div>
          </div>
        </>
      )}
    </div>
  );
}
