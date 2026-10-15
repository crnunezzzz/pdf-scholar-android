// Build the renderer for the Android app into dist-android/, which Capacitor
// copies into the APK's assets (capacitor.config.ts → webDir). Same renderer
// as the desktop and the web preview; the platform layer is picked at runtime
// (bridge.ts → android-api.ts). See docs/ANDROID.md.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'

export default defineConfig({
  root: resolve(__dirname, '../src/renderer'),
  // Served from https://localhost/ by Capacitor; relative URLs keep the build
  // independent of where the WebView mounts it
  base: './',
  plugins: [react(), pdfjsAssets()],
  resolve: {
    // pdf.js's LEGACY build: the modern one calls JavaScript that only the
    // newest Chromium has (Map.prototype.getOrInsertComputed and friends —
    // every page failed to draw on a Chromium 141 WebView). Android System
    // WebView lags the desktop runtime, so the APK takes the build that
    // carries its own polyfills. Same API, same version.
    alias: [
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
      {
        find: /^pdfjs-dist\/build\/pdf\.worker\.mjs\?worker$/,
        replacement: 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker'
      }
    ]
  },
  build: {
    outDir: resolve(__dirname, '../dist-android'),
    emptyOutDir: true,
    // Android System WebView is evergreen Chromium (minWebViewVersion in
    // capacitor.config.ts), so the same target as the extension holds
    target: 'es2022'
  }
})
