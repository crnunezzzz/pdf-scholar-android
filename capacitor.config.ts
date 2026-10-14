// Capacitor wraps the renderer as the Android app (docs/ANDROID.md).
// `npm run android:sync` builds dist-android/ and copies it into android/.
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'io.github.crnunezzzz.pdfscholar',
  appName: 'PDF Scholar',
  webDir: 'dist-android',
  android: {
    // pdf.js v6 and the wasm engine need a modern Chromium; older WebViews
    // get Capacitor's «update Android System WebView» page instead of a
    // blank reader
    minWebViewVersion: 120
  },
  plugins: {
    SystemBars: {
      // The app does not draw under the status/navigation bars: no
      // viewport-fit=cover in index.html, so the WebView is inset for us
      insetsHandling: 'css'
    }
  }
}

export default config
