import { existsSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base './' so it works under GitHub Pages at /<repo>/v5/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode === 'production') {
    // Fail the build instead of silently shipping an app that points at "undefined".
    const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter(k => !env[k] && !process.env[k]);
    if (missing.length) throw new Error(`Missing build env: ${missing.join(', ')} (see .env.example)`);
    if ((env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '').includes('service_role'))
      throw new Error('Refusing to build: a service_role key must never be bundled into the browser app.');
    for (const f of ['public/icon-192.png', 'public/icon-512.png'])
      if (!existsSync(f)) throw new Error(`Missing ${f}: copy the V4 icons into v5/web/public/ and commit them.`);
  }
  const buildId = `${(process.env.GITHUB_SHA ?? 'local').slice(0, 7)}-${process.env.BUILD_TIME ?? 'dev'}`;
  return {
    base: './',
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    plugins: [react(), VitePWA({
      registerType: 'autoUpdate',
      manifest: { name: 'My Life OS V5', short_name: 'Life OS', start_url: './', scope: './', display: 'standalone',
        background_color: '#f5f7fb', theme_color: '#111827',
        icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] },
      // App shell only. API responses (user data) are never put in the service-worker cache.
      workbox: { navigateFallback: 'index.html', runtimeCaching: [], cleanupOutdatedCaches: true },
    })],
  };
});
