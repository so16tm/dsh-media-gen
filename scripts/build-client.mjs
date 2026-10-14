// Build the browser half into DSH's client module format: one CommonJS
// factory registered with window.__ModuleLoader__, with the modules the DSH
// page shares left as require() calls and everything else bundled.
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// Modules the DSH page provides (packages/client/web/src/platform.ts in DSH).
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const production = process.env.NODE_ENV !== 'development'

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  sourcemap: true,
  minify: production,
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})
