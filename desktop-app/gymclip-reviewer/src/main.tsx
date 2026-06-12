import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {setApiToken} from './api/http';
import {initSentry, SentryErrorBoundary} from './lib/sentry';
import {UpdateToast} from './features/update';

initSentry();

async function loadApiTokenBeforeMount(): Promise<void> {
  // The backend (spawned with GYMCLIP_API_TOKEN) rejects /api requests that
  // lack the token, so it must be in place BEFORE React mounts: the first
  // render already fires project fetches and synchronously builds media
  // URLs (stream/thumbnails). In pure-browser dev there is no desktop
  // bridge and the bare backend does not enforce auth — skip silently.
  try {
    const token = await window.gymclipDesktop?.getApiToken?.();
    if (token) {
      setApiToken(token);
    }
  } catch (error) {
    console.error('Failed to load API token from desktop bridge', error);
  }
}

void loadApiTokenBeforeMount().then(() => {
  renderApp();
});

function renderApp() {
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SentryErrorBoundary
      fallback={({resetError, eventId}) => (
        <div
          style={{
            padding: '2rem',
            fontFamily: 'system-ui',
            maxWidth: '600px',
            margin: '4rem auto',
            textAlign: 'center',
          }}
        >
          <h2>应用出错了</h2>
          <p>
            错误已自动上报。Event ID: <code>{eventId}</code>
          </p>
          <p>请尝试重置；如反复出现，关闭并重新打开 GymClip Reviewer。</p>
          <button onClick={resetError} style={{padding: '0.5rem 1rem', marginTop: '1rem'}}>
            重置
          </button>
        </div>
      )}
      showDialog={false}
    >
      <App />
      <UpdateToast />
    </SentryErrorBoundary>
  </StrictMode>,
);
}
