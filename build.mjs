/**
 * Build both halves of the dual-face plugin.
 *
 * The node half is plain ESM and carries no runtime import outside `node:`
 * builtins, so it survives any version skew between this package and the
 * installed harness.
 *
 * The browser half is a classic-script CJS bundle wrapped in the
 * `window.__ModuleLoader__.load({ id, factory })` handoff the client module
 * system requires: the shell injects `<script src="/plugins/<id>/client.js">`
 * and reads the factory out of that call, so the artifact must not be ESM and
 * every shared module must arrive through the injected `require`.
 */
import { rm, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

/** Package name; it is the module-table id the browser half registers under. */
const ID = 'recycle-image-gen'

/**
 * The client module table's baseline rows (`packages/client/web/src/platform.ts`),
 * which every dynamic browser bundle may require. Anything else must inline.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
