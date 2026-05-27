import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {initSentry, SentryErrorBoundary} from './lib/sentry';

initSentry();

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
    </SentryErrorBoundary>
  </StrictMode>,
);
