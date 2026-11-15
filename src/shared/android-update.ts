// Where the Android app hears about its next version, and how it tells one
// build from the next.
//
// The APK is not on a store, so nothing updates it by itself. The
// «Android release» workflow (.github/workflows/android-release.yml) merges the
// original repository into this one every day, builds an APK and publishes it
// as the repository's latest GitHub release, tagged `android-v<version>-b<build>`
// with the APK under one fixed asset name. The app asks that release feed at
// start (an HTTPS GET, the same check the macOS build makes) and, when the
// release's build number is higher than its own, offers the download; Android
// installs the APK over the old one (same signing key, higher versionCode).
//
// The build number is minutes since 2020-01-01 UTC, stamped by CI into both
// the APK's versionCode and the renderer (VITE_ANDROID_BUILD). The package
// version alone cannot order builds: the original repository does not bump it
// for every change, and the Android layer changes without it.
// Platform-free on purpose, so scripts/test-android-update.mjs can import it.

/** The repository this build was published from, when CI told the renderer
 *  (GITHUB_REPOSITORY), else the one the Android port lives in */
export const DEFAULT_ANDROID_REPO = 'crnunezzzz/pdf-scholar-android'

/** The APK's name inside every release: fixed, so `/releases/latest/download/`
 *  always reaches the newest one */
export const ANDROID_APK_ASSET = 'PDF-Scholar-android.apk'

/** `owner/name` only — anything else would reshape the URLs built from it */
export function cleanRepo(repo: unknown): string {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_ANDROID_REPO
}

/** Newest non-draft, non-prerelease release of the repository */
export const androidReleasesApi = (repo: string): string =>
  `https://api.github.com/repos/${cleanRepo(repo)}/releases/latest`

/** The APK of the newest release, downloaded by the browser */
export const androidApkUrl = (repo: string): string =>
  `https://github.com/${cleanRepo(repo)}/releases/latest/download/${ANDROID_APK_ASSET}`

/** The release tag CI writes: `android-v0.84.0-b3608640` */
export const androidTag = (version: string, build: number): string => `android-v${version}-b${build}`

/** The version and build inside a release tag, or null for any other shape
 *  (a desktop `v0.84.0` tag, garbage): an unknown shape must never read as
 *  newer, or every launch would nag about it */
export function parseAndroidTag(tag: unknown): { version: string; build: number } | null {
  if (typeof tag !== 'string') return null
  const m = /^android-v(\d+\.\d+\.\d+)-b(\d{1,10})$/.exec(tag.trim())
  if (!m) return null
  const build = Number(m[2])
  return Number.isSafeInteger(build) && build > 0 ? { version: m[1], build } : null
}

/** This build's own number from what CI stamped (VITE_ANDROID_BUILD); 0 for a
 *  local build, which then never checks — it was not published anywhere */
export function ownBuild(stamped: unknown): number {
  const s = typeof stamped === 'number' ? String(stamped) : stamped
  if (typeof s !== 'string' || !/^\d{1,10}$/.test(s)) return 0
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : 0
}

/** The build number for a moment: whole minutes since 2020-01-01 UTC. Fits a
 *  versionCode (≤ 2 100 000 000) until the year 5900. */
export const buildAt = (ms: number): number => Math.floor((ms - Date.UTC(2020, 0, 1)) / 60000)

/** What the reader sees as the new version: the package version and the day
 *  it was built, since two builds can share a package version */
export function buildLabel(version: string, build: number): string {
  const day = new Date(Date.UTC(2020, 0, 1) + build * 60000).toISOString().slice(0, 10)
  return `${version} (${day})`
}

/** The release on offer when it is newer than this build, else null. A local
 *  build (0) never is offered one. */
export function newerRelease(
  release: unknown,
  own: number
): { version: string; build: number; label: string } | null {
  if (own <= 0 || !release || typeof release !== 'object') return null
  const r = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
  if (r.draft === true || r.prerelease === true) return null
  const tag = parseAndroidTag(r.tag_name)
  if (!tag || tag.build <= own) return null
  return { ...tag, label: buildLabel(tag.version, tag.build) }
}
