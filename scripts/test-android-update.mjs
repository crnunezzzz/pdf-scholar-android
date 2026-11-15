// The Android app's update check (src/shared/android-update.ts): which release
// counts as newer than the running APK. Both failure modes are silent — too
// eager and every launch nags about a build that is not newer, too shy and a
// reader stays on an old APK for good — so the arithmetic is pinned here.
// Run: node scripts/test-android-update.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/android-update.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'android-update-'))
const out = join(dir, 'android-update.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const U = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${g}\n      want ${w}`)
  } else console.log(`  ✓ ${msg}`)
}

console.log('tags')
eq(U.parseAndroidTag('android-v0.84.0-b3608640'), { version: '0.84.0', build: 3608640 }, 'a CI tag')
eq(U.parseAndroidTag(U.androidTag('1.2.3', 42)), { version: '1.2.3', build: 42 }, 'androidTag round-trips')
eq(U.parseAndroidTag('v0.84.0'), null, "the original repository's desktop tag is not ours")
eq(U.parseAndroidTag('android-v0.84-b1'), null, 'a two-part version')
eq(U.parseAndroidTag('android-v0.84.0-b0'), null, 'build 0 is the local build, never a release')
eq(U.parseAndroidTag('android-v0.84.0-b12345678901'), null, 'more digits than a versionCode holds')
eq(U.parseAndroidTag(null), null, 'no tag')

console.log('own build')
eq(U.ownBuild('3608640'), 3608640, 'stamped by CI')
eq(U.ownBuild(undefined), 0, 'a local build')
eq(U.ownBuild(''), 0, 'empty')
eq(U.ownBuild('12x'), 0, 'garbage')

console.log('newer?')
const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra })
eq(U.newerRelease(rel('android-v0.84.0-b200'), 100)?.build, 200, 'a higher build is offered')
eq(U.newerRelease(rel('android-v0.84.0-b100'), 100), null, 'the same build is not')
eq(U.newerRelease(rel('android-v0.90.0-b99'), 100), null, 'the build orders, not the version')
eq(U.newerRelease(rel('android-v0.84.0-b200'), 0), null, 'a local build never checks')
eq(U.newerRelease(rel('android-v0.84.0-b200', { prerelease: true }), 100), null, 'a prerelease is not offered')
eq(U.newerRelease(rel('android-v0.84.0-b200', { draft: true }), 100), null, 'a draft is not offered')
eq(U.newerRelease({ message: 'Not Found' }, 100), null, 'a 404 body')
eq(U.newerRelease('nonsense', 100), null, 'not an object')

console.log('numbers and URLs')
eq(U.buildAt(Date.UTC(2020, 0, 1)), 0, 'the epoch is build 0')
eq(U.buildAt(Date.UTC(2026, 10, 15, 12, 0)) > U.buildAt(Date.UTC(2026, 10, 15, 11, 59)), true, 'a minute later is higher')
eq(U.buildAt(Date.UTC(2100, 0, 1)) < 2100000000, true, 'fits a versionCode for long')
eq(U.buildLabel('0.84.0', U.buildAt(Date.UTC(2026, 10, 15, 8))), '0.84.0 (2026-11-15)', 'the label names the day')
eq(U.androidApkUrl('a/b'), 'https://github.com/a/b/releases/latest/download/PDF-Scholar-android.apk', 'APK URL')
eq(U.androidReleasesApi('a/b'), 'https://api.github.com/repos/a/b/releases/latest', 'API URL')
eq(U.cleanRepo('a/b?x=1'), U.DEFAULT_ANDROID_REPO, 'a repo that would reshape the URL falls back')
eq(U.cleanRepo(undefined), U.DEFAULT_ANDROID_REPO, 'no repo falls back')

if (failures) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
