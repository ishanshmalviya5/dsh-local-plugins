// Bundle client/index.jsx -> client/client.js in the dsh client module format
// (same wrapper as dsh-pocket's build): react and the UI primitives stay
// external and come from the host's module table.
//   node client/build.mjs          write client/client.js
//   node client/build.mjs --check  fail if client/client.js is not exactly what the source builds to
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, 'client.js');

export async function bundle() {
  const result = await build({
    entryPoints: [resolve(here, 'index.jsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome100'],
    external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    write: false,
    legalComments: 'none',
  });
  return `window.__ModuleLoader__.load({
  id: "dsh-local-plugins",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${result.outputFiles[0].text}
    return module.exports;
  }
});
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await bundle();
  if (process.argv.includes('--check')) {
    const have = await readFile(target, 'utf8').catch(() => '');
    if (have !== built) {
      console.error('client/client.js is out of date: run `npm run build` and commit the result.');
      process.exit(1);
    }
    console.log('client/client.js is up to date');
  } else {
    await writeFile(target, built);
    console.log('wrote client/client.js');
  }
}
