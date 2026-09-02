'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT, resetGeneratedDirectory } = require('./files.cjs');
const { vendorAssets } = require('./vendor.cjs');
const { checkProject } = require('./check.cjs');

function build() {
  vendorAssets();
  const files = checkProject();
  const output = resetGeneratedDirectory('dist');
  let bytes = 0;
  for (const file of files) {
    const target = path.join(output, path.relative(PROJECT_ROOT, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    bytes += fs.statSync(target).size;
  }
  checkProject(output, { syntax: false });
  console.log(`Built dist/: ${files.length} static files, ${bytes.toLocaleString('en-US')} bytes. Source tooling, hidden configuration, and node_modules excluded.`);
  return output;
}

if (require.main === module) build();
module.exports = { build };
