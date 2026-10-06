// Bundle client/index.jsx -> client/client.js in the dsh client module format
// (same wrapper as dsh-pocket's build): react and the UI primitives stay
// external and come from the host's module table.
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

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

const bundled = result.outputFiles[0].text;
await writeFile(resolve(here, 'client.js'), `window.__ModuleLoader__.load({
  id: "dsh-local-plugins",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`);
console.log('wrote client/client.js');
