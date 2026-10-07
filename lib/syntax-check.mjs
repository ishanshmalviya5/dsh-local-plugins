// Child process: parse every file named on stdin WITHOUT running any of it.
// Needs `node --experimental-vm-modules` (SourceTextModule parses ES modules; vm.Script parses CommonJS).
// stdin : { files: string[], moduleType: "module" | "commonjs" }
// stdout: { bad: [{ file, message }] }
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { files, moduleType } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const asEsm = (src, file) => { try { new vm.SourceTextModule(src, { identifier: file }); return null; } catch (e) { return e; } };
const asCjs = (src, file) => { try { new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file }); return null; } catch (e) { return e; } };

const bad = [];
for (const file of files) {
  let src;
  try { src = readFileSync(file, 'utf8').replace(/^#!.*/, ''); } catch (e) { bad.push({ file, message: `unreadable: ${e.message}` }); continue; }
  let err;
  if (file.endsWith('.mjs')) err = asEsm(src, file);
  else if (file.endsWith('.cjs')) err = asCjs(src, file);
  else {
    // like Node itself: use the package's module type, and if that fails try the other (syntax detection)
    const [first, second] = moduleType === 'module' ? [asEsm, asCjs] : [asCjs, asEsm];
    err = first(src, file);
    if (err && !second(src, file)) err = null;
  }
  if (err) bad.push({ file, message: `${err.name}: ${String(err.message).split('\n')[0]}` });
}
process.stdout.write(JSON.stringify({ bad }));
