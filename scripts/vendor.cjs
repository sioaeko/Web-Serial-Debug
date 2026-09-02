'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PROJECT_ROOT, resetGeneratedDirectory } = require('./files.cjs');

const ASSETS = [
  ['bootstrap', 'dist/css/bootstrap.min.css', 'bootstrap/bootstrap.min.css'],
  ['bootstrap', 'dist/js/bootstrap.bundle.min.js', 'bootstrap/bootstrap.bundle.min.js'],
  ['bootstrap', 'LICENSE', 'bootstrap/LICENSE'],
  ['@popperjs/core', 'LICENSE.md', 'popper/LICENSE.md'],
  ['bootstrap-icons', 'font/bootstrap-icons.css', 'bootstrap-icons/bootstrap-icons.css'],
  ['bootstrap-icons', 'font/fonts/bootstrap-icons.woff', 'bootstrap-icons/fonts/bootstrap-icons.woff'],
  ['bootstrap-icons', 'font/fonts/bootstrap-icons.woff2', 'bootstrap-icons/fonts/bootstrap-icons.woff2'],
  ['bootstrap-icons', 'LICENSE', 'bootstrap-icons/LICENSE'],
  ['codemirror', 'lib/codemirror.css', 'codemirror/codemirror.min.css'],
  ['codemirror', 'theme/idea.css', 'codemirror/idea.min.css'],
  ['codemirror', 'lib/codemirror.js', 'codemirror/codemirror.min.js'],
  ['codemirror', 'addon/selection/active-line.js', 'codemirror/active-line.min.js'],
  ['codemirror', 'addon/edit/matchbrackets.js', 'codemirror/matchbrackets.min.js'],
  ['codemirror', 'mode/javascript/javascript.js', 'codemirror/javascript.min.js'],
  ['codemirror', 'LICENSE', 'codemirror/LICENSE'],
  // The upstream js/ansi_up.min.js stays untouched; only its license is copied.
  ['ansi_up', 'LICENSE', 'ansi_up/LICENSE']
];

function vendorAssets() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const versions = {};
  const prepared = ASSETS.map(([packageName, source, target]) => {
    const packageRoot = path.join(PROJECT_ROOT, 'node_modules', packageName);
    const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const expected = packageJson.dependencies[packageName];
    if (expected && installed.version !== expected) throw new Error(`Run npm ci: ${packageName} must be ${expected}, not ${installed.version}.`);
    versions[packageName] = installed.version;
    let content = fs.readFileSync(path.join(packageRoot, source));
    if (/\.(?:js|css)$/.test(source)) {
      // Omit unavailable source-map references, retaining all license comments.
      content = Buffer.from(content.toString('utf8').replace(/\/\/[#@]\s*sourceMappingURL=[^\r\n]*/g, '').replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, ''));
    }
    return { target, content };
  });

  const output = resetGeneratedDirectory('vendor');
  const hashes = {};
  for (const { target, content } of prepared) {
    const file = path.join(output, target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    hashes[target] = createHash('sha256').update(content).digest('hex');
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify({ versions, sha256: hashes }, null, 2)}\n`);
  console.log(`Vendored ${prepared.length} assets/licenses from pinned local npm packages.`);
  return prepared.length;
}

if (require.main === module) vendorAssets();
module.exports = { ASSETS, vendorAssets };
