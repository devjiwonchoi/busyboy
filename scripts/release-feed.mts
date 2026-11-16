// Prepares the files installed apps read to find and trust an update, in a
// folder that holds a release's installers.
//
//   UPDATE_SIGNING_KEY=<pem> node scripts/release-feed.mts <version> <release-dir>
//
// Two things happen:
//
// 1. Windows builds each architecture on its own runner, and each writes a
//    latest.yml. An installed app reads one latest.yml and picks the installer
//    whose name contains its architecture, so `latest-<arch>.yml` files are
//    merged into one.
//
// 2. BusyBoy 0.0.22 and earlier install a macOS update only when the release
//    has `busyboy-update.json`, listing every installer and ZIP with its
//    SHA-512, and `busyboy-update.json.sig`, an Ed25519 signature of that file
//    made with the key in the release environment's UPDATE_SIGNING_KEY. Both
//    are written here and then checked the way those apps check them, so a
//    release they would refuse is never published.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MANIFEST = 'busyboy-update.json'
const SIGNATURE = 'busyboy-update.json.sig'
/** What an installed app downloads to update, or a person downloads to install. */
const SIGNED_EXTENSIONS = new Set(['.zip', '.dmg', '.exe'])

/** The public half of UPDATE_SIGNING_KEY that BusyBoy 0.0.22 and earlier ship with. */
const INSTALLED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANJ4s4kF9EZwmC3l5wcpv0x5l26/Dxmw0ZAgtPH6k9no=
-----END PUBLIC KEY-----`

type FeedFile = { url: string; sha512: string; size: number }
type Feed = { version: string; releaseDate: string; files: FeedFile[] }

const unquote = (value: string) => {
  const text = value.trim()
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Reads the part of electron-builder's latest.yml that an installed app uses. */
function parseFeed(raw: string, source: string): Feed {
  let version: string | undefined
  let releaseDate: string | undefined
  const files: Partial<FeedFile>[] = []
  for (const line of raw.split(/\r?\n/)) {
    const url = /^ {2}- url:\s*(.+)$/.exec(line)
    if (url) {
      files.push({ url: unquote(url[1]) })
      continue
    }
    const field = /^ {4}(sha512|size):\s*(.+)$/.exec(line)
    if (field) {
      const file = files.at(-1)
      if (!file) throw new Error(`${source}: ${field[1]} outside a file entry.`)
      if (field[1] === 'size') file.size = Number(field[2])
      else file.sha512 = unquote(field[2])
      continue
    }
    const top = /^(version|releaseDate):\s*(.+)$/.exec(line)
    if (top?.[1] === 'version') version = unquote(top[2])
    if (top?.[1] === 'releaseDate') releaseDate = unquote(top[2])
  }
  if (!version || !releaseDate || files.length === 0) throw new Error(`${source}: missing version, releaseDate, or files.`)
  return {
    version,
    releaseDate,
    files: files.map((file) => {
      if (!file.url || !file.sha512 || !Number.isFinite(file.size)) throw new Error(`${source}: incomplete entry ${file.url ?? ''}.`)
      return { url: file.url, sha512: file.sha512, size: file.size as number }
    }),
  }
}

function serializeFeed(feed: Feed) {
  const [first] = feed.files
  return [
    `version: ${quote(feed.version)}`,
    'files:',
    ...feed.files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    // The fields older updaters read when a feed lists one file.
    `path: ${first.url}`,
    `sha512: ${first.sha512}`,
    `releaseDate: ${quote(feed.releaseDate)}`,
    '',
  ].join('\n')
}

/** Merges `latest-<arch>.yml` into latest.yml. Returns whether there was anything to merge. */
function mergeWindowsFeeds(dir: string, version: string) {
  const parts = readdirSync(dir)
    .filter((name) => /^latest-(x64|arm64)\.yml$/.test(name))
    // x64 first: an updater that reads only the top-level `path` gets the installer that runs everywhere.
    .sort((a, b) => Number(b.includes('x64')) - Number(a.includes('x64')))
  if (parts.length === 0) return false
  const feeds = parts.map((name) => parseFeed(readFileSync(join(dir, name), 'utf8'), name))
  const files = new Map<string, FeedFile>()
  for (const feed of feeds) {
    if (feed.version !== version) throw new Error(`A Windows feed is for ${feed.version}, not ${version}.`)
    for (const file of feed.files) files.set(file.url, file)
  }
  const releaseDate = feeds.map((feed) => feed.releaseDate).sort().at(-1) as string
  writeFileSync(join(dir, 'latest.yml'), serializeFeed({ version, releaseDate, files: [...files.values()] }))
  for (const name of parts) rmSync(join(dir, name))
  return true
}

async function hashFile(path: string) {
  const hash = createHash('sha512')
  let size = 0
  await pipeline(createReadStream(path), async (source) => {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.byteLength
      hash.update(chunk)
    }
  })
  return { sha512: hash.digest('base64'), size }
}

type SignedManifest = { version: string; files: { name: string; sha512: string; size: number }[] }

async function signInstallers(dir: string, version: string, privateKeyPem: string) {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim()
  if (publicKey !== INSTALLED_PUBLIC_KEY) {
    throw new Error('UPDATE_SIGNING_KEY is not the key installed apps trust, so they would refuse this release.')
  }
  const names = readdirSync(dir)
    .filter((name) => SIGNED_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
  if (names.length === 0) throw new Error(`No installers or ZIPs in ${dir}.`)
  const manifest: SignedManifest = { version, files: [] }
  for (const name of names) manifest.files.push({ name, ...(await hashFile(join(dir, name))) })
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, MANIFEST), bytes)
  writeFileSync(join(dir, SIGNATURE), `${sign(null, bytes, privateKey).toString('base64')}\n`)
  return manifest
}

/**
 * The checks BusyBoy 0.0.22 runs before it installs: the signature covers the
 * manifest, the manifest is for this version, and the ZIP it will download
 * (`BusyBoy-<version>-<arch>.zip`) is listed with the hash and size of the file.
 */
async function checkAsInstalledApps(dir: string, version: string, productName: string) {
  const bytes = readFileSync(join(dir, MANIFEST))
  const signature = Buffer.from(readFileSync(join(dir, SIGNATURE), 'utf8').trim(), 'base64')
  if (signature.byteLength !== 64 || !verify(null, bytes, INSTALLED_PUBLIC_KEY, signature)) {
    throw new Error(`${SIGNATURE} does not verify against the key installed apps trust.`)
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as SignedManifest
  if (manifest.version !== version) throw new Error(`${MANIFEST} is for ${manifest.version}, not ${version}.`)
  const zip = `${productName}-${version}-arm64.zip`
  const listed = manifest.files.find(({ name }) => name === zip)
  if (!listed) throw new Error(`${MANIFEST} does not list ${zip}, the file an installed Mac app downloads.`)
  const actual = await hashFile(join(dir, zip))
  if (actual.sha512 !== listed.sha512 || actual.size !== listed.size) throw new Error(`${zip} does not match ${MANIFEST}.`)
}

const [version, dir] = process.argv.slice(2)
if (!version || !dir || !existsSync(dir)) {
  console.error('usage: release-feed.mts <version> <release-dir>')
  process.exit(1)
}
const privateKeyPem = process.env.UPDATE_SIGNING_KEY
if (!privateKeyPem) {
  console.error('::error::Missing secret UPDATE_SIGNING_KEY in the release environment.')
  process.exit(1)
}
const { productName } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { productName: string }

if (mergeWindowsFeeds(dir, version)) console.log('Merged the Windows feeds into latest.yml.')
const manifest = await signInstallers(dir, version, privateKeyPem)
await checkAsInstalledApps(dir, version, productName)
console.log(`Signed ${MANIFEST} for v${version}; an installed BusyBoy would accept it:`)
for (const file of manifest.files) console.log(`  ${file.name}  ${file.size} bytes`)
