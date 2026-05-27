import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { defineConfig } from 'vite';

// C-6: Sentry source-map upload — only active when SENTRY_AUTH_TOKEN + SENTRY_ORG +
// SENTRY_PROJECT_FRONTEND are present (i.e. CI release builds). In dev / local builds
// the plugin no-ops, so this stays zero-friction for everyday `npm run build`.
const sentryEnabled =
  Boolean(process.env.SENTRY_AUTH_TOKEN) &&
  Boolean(process.env.SENTRY_ORG) &&
  Boolean(process.env.SENTRY_PROJECT_FRONTEND);

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    sentryEnabled &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT_FRONTEND,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: {
          name: process.env.SENTRY_RELEASE || undefined,
        },
        sourcemaps: {
          assets: './dist/**/*.{js,map}',
        },
        telemetry: false,
      }),
  ].filter(Boolean),
  build: {
    // 'hidden' = generate source maps for upload but don't reference them in shipped JS
    sourcemap: sentryEnabled ? 'hidden' : false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
