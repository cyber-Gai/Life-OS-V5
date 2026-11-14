import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
// base './' so it works under GitHub Pages at /<repo>/v5/
export default defineConfig({
  base: './',
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: { name: 'My Life OS V5', short_name: 'Life OS', start_url: './', scope: './', display: 'standalone',
      background_color: '#f5f7fb', theme_color: '#111827',
      icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] },
    workbox: { navigateFallback: 'index.html' }
  })]
});
