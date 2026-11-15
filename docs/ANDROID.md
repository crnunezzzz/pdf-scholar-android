# Android app

PDF Scholar on Android is the same renderer the desktop and the extension run
(React + pdf.js + the EmbedPDF engine), wrapped by [Capacitor](https://capacitorjs.com)
in a native Android app and shipped as an APK. Tabs, the split view (the same
document twice, or two documents side by side), annotations, bookmarks,
search, reading modes, the library and the AI assistant all come from the
shared renderer; only the platform layer is new. Tier and divergences:
`docs/PLATFORMS.md` (tier 3, divergence 31).

## Install the APK

1. Open the repository's **Releases** (the latest one is marked «Latest») and
   download **PDF-Scholar-android.apk** — on the tablet itself is easiest.
   Every push also leaves an APK on its **Android** workflow run (artifact
   **pdf-scholar-android-apk**), for trying a branch before it is released.
2. Open the `.apk` and allow «install unknown apps» for the app you opened it
   with when Android asks.
3. A newer APK installs over the old one and keeps the library, positions and
   settings: every build is signed with the same debug key, checked in as
   `android/app/debug.keystore` (a CI runner would otherwise make a new one per
   run, and Android refuses an update signed with another key). A debug key is
   not a release key: for the Play Store, see «Release build» below.

## Updates

The app follows the original repository (emilmsh/pdf-scholar) by itself:

- **Every day** (and on every push to master, and by hand from the Actions
  tab) `.github/workflows/android-release.yml` merges the original
  repository's master into this one's, builds the APK and publishes it as the
  latest release, tagged `android-v<version>-b<build>`. Nothing is published
  when nothing changed since the last release.
- **The app checks** that release feed a few seconds after it starts, and
  again when it comes back to the front after six hours. A newer build raises
  the update notice; «Open download» hands the APK to the browser, and opening
  the download installs it over the running app. The gear menu and the start
  screen have «Check for updates» for the same check on demand. Nothing is
  downloaded or installed without a tap.
- **The build number** is minutes since 2020-01-01 UTC, stamped by CI into the
  APK's versionCode and the renderer (`VITE_ANDROID_BUILD`); the package
  version cannot order builds, since the original repository does not bump it
  for every change. `src/shared/android-update.ts` holds the rules,
  `npm run test:android-update` pins them. A local build carries no number and
  never checks.
- **A merge that conflicts** (the original changed lines the Android layer
  also changed) publishes nothing and opens one issue, «Android: the original
  repository no longer merges cleanly», listing the files; the last good
  release stays on offer. Merge `upstream/master` into master by hand, and the
  next run publishes again.
- **Keeping master itself current** needs a secret `SYNC_TOKEN`: a personal
  access token with the `repo` and `workflow` scopes (the original repository
  changes its own workflow files, which GitHub refuses from the built-in
  token). Without it each release still carries the merge, but the merge lives
  only in that build, and master stays where it was.
- Scheduled workflows stop after 60 days without activity in the repository;
  GitHub then shows a button on the workflow's page to turn it back on.

## How it is put together

| Piece | Where |
| --- | --- |
| Web build for the app | `config/vite.android.config.ts` → `dist-android/` |
| Capacitor config (app id, WebView floor, system bars) | `capacitor.config.ts` |
| Platform layer (the `PdfxApi` for Android) | `src/renderer/src/android-api.ts`, picked in `bridge.ts` |
| Native half: files, printing, «Open with» | `android/app/src/main/java/io/github/crnunezzzz/pdfscholar/PdfFilesPlugin.java` |
| Intents (open/share a PDF to the app) | `android/app/src/main/AndroidManifest.xml` |
| CI build of the APK | `.github/workflows/android.yml` |
| Daily merge of the original + release | `.github/workflows/android-release.yml` |
| Update check (in the app) | `src/shared/android-update.ts`, `createAndroidUpdates` in `android-api.ts` |

- **Documents** are opened with the system file picker (Storage Access
  Framework) and keyed on their `content://` URI. The app takes a persistable
  read+write grant, so recents reopen after a restart and Save writes back to
  the same file. A PDF another app hands over («Open with», share sheet) may
  be read-only; saving it goes through «Save as».
- **Bytes** come in through a cache copy the WebView fetches from Capacitor's
  local server (never a 40 MB base64 string over the bridge); saves, prints
  and shares go out as base64 once.
- **pdf.js** is aliased to its legacy build for this target only: the modern
  build calls `Map.prototype.getOrInsertComputed`, which a Chromium 141
  WebView does not have, and every page failed to draw.
- **Fonts a PDF names but does not embed** (Word does this with Cambria,
  Calibri, Times New Roman, Arial…): pdf.js asks the system for them, and an
  Android device has none — the text came out in the device's generic serif
  squeezed into the document's widths. `src/renderer/src/pdf-fonts.ts` hands
  pdf.js metric-identical twins shipped in the APK instead (Caladea, Carlito,
  Tinos, Arimo, Cousine, Gelasio; SIL OFL, `LICENSE-fonts.txt`), so every
  glyph keeps the width the document gave it. A family with no free twin
  (Aptos, Garamond, …) still falls back to the generic face; embedded fonts
  were never affected. `npm run test:pdf-fonts` guards the mapping.
- **AI** is the extension's client (`extension-ai.ts`): the reader's own key,
  sealed with WebCrypto, calls straight from the WebView (origin
  `https://localhost`). A provider reached that way must answer CORS; one that
  does not fails here although it works on the desktop. Which do has not been
  checked on a device yet — `npm run test:live` covers the desktop only.
- **Fullscreen** (the ⤢ button, always in the toolbar on Android, or F) is
  the phone's page-only view: Android's sticky immersive mode hides the
  status and navigation bars, the tab strip goes, and the toolbar tucks away
  whatever its pin says. A swipe down from the top (within 48 px — the very
  edge belongs to the system's own bars) brings the toolbar back for a few
  seconds; the same button, or Back, leaves. Returning to the app keeps it
  fullscreen. The very first time, Android itself shows a «Viewing full
  screen» notice that holds Back until it is tapped away — once per install.
- **Two documents side by side**: the split-view button (in the toolbar,
  the last button to fold into «…») asks how many documents and which
  — a panel over the right half starts with 1 / 2 / 3 documents (3 is the
  mosaic below, at once; it waits for a third tab), and for two lists this
  document (both columns on it), the other open tabs, and «Another file …»;
  a tap opens it in the second column,
  a tap beside the panel or its cross puts the question away
  (`src/renderer/src/components/SplitPicker.tsx`). Pressed again it closes the
  split. A finger can also drag a tab onto the
  left or right half of the pages (`src/renderer/src/tab-touch-drag.ts` turns
  the finger's gesture into the drag events a mouse drag delivers, so the
  desktop's drop targets and hints work unchanged). While the tab strip
  scrolls, a sideways swipe scrolls it and the drag starts by pulling down
  or after a short hold; a hold released in place opens the tab's menu. The
  layout menu's «Open in split view» list does the same without a drag.
- **Three documents at once** (the mosaic, desktop too): the layout menu's
  «Show three documents» puts this tab on half the window and the next two
  on a quarter each — left half and right quarters in landscape, top half and
  bottom quarters upright. Each tile is a whole viewer; a tap focuses one; a
  tab dragged onto a tile, or tapped in the strip, takes that place.
  «Back to one document» ends it, as does closing a tile's tab.
- **Back button** leaves fullscreen first; otherwise it sends the app to the
  background (tabs stay as they were). The session restores the tab strip
  after the app is closed.
- The status bar's icons follow the reading theme.

## Build locally

Needs Node 22, JDK 21 and the Android SDK (Android Studio installs it).

```sh
npm ci
npm run android:sync   # build dist-android/ and copy it into android/
npm run android:apk    # …and assemble android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open   # or open the project in Android Studio
```

Renderer changes need `android:sync` again before the next APK. The launcher
icons and splash screens under `android/app/src/main/res/` were drawn from
`build/icon.png`; redraw them when that changes.

To look at the phone layout without a device, `npm run build:android` and
`npx vite preview --config config/vite.android.config.ts`, then open
`http://localhost:4173/#open=sample.pdf` at a phone-sized viewport (Chromium
device mode). The platform layer falls back to the web one there.

## Release build

The CI APK is debug-signed. For a store upload, create a keystore, add a
`signingConfigs.release` to `android/app/build.gradle` reading it from
environment variables, and run `./gradlew bundleRelease` for an `.aab`. Keep
the keystore out of the repository — losing it means no further updates to
the same store listing.

## On a device: `npm run test:android-device`

`scripts/test-android-device.mjs` installs the debug APK on whatever `adb`
sees (a USB device, or an emulator) and drives the WebView over its DevTools
socket: two documents through «Open with» become two tabs, the two-document
split through the split button's «which document?» panel, fullscreen hides the system bars, tab strip and
toolbar, a swipe shows the toolbar, Back leaves fullscreen without leaving
the app, a pen stroke saved in place reaches the file (`/Ink` in its bytes)
and no other, the device turned upright keeps a toolbar that fits, a third
document and the three-document mosaic (upright and turned, then a finger
dragging a tab onto the large tile), and a cold restart brings all three
tabs back. The documents are three DIFFERENT PDFs from
`scripts/fixtures/android/` (title, page count, page shape and font differ;
`make-fixtures.py` regenerates them), and every tab, split column and tile is
checked for showing its own by the title in its text and the page count in
its toolbar — copies of one file could not catch a view showing the wrong
document. Screenshots land in `android-shots/`.

CI runs it on an emulated **Pixel Tablet** (Android 15) on every pull
request (`.github/workflows/android-tablet.yml`, screenshots attached to the
run). It cannot reach the system file picker, the print dialog or the share
sheet — those, and one AI question, stay a hand check on a real device before
calling a version good.
