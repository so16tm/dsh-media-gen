// Assemble the installable package into dist/: the built lib/ and the files
// it loads, with a package.json that has no build scripts or dev
// dependencies, so `dsh plugin add` installs it from a git branch without
// building anything. Run after `pnpm build`.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const out = new URL('dist/', root)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

delete pkg.scripts
delete pkg.devDependencies
// Sources are not shipped, so their export would point nowhere.
delete pkg.exports['./src/*']

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const path of ['lib', 'locale', 'cordis.patch.yml', 'README.md']) {
  await cp(new URL(path, root), new URL(path, out), { recursive: true })
}
await writeFile(new URL('package.json', out), `${JSON.stringify(pkg, null, 2)}\n`)
