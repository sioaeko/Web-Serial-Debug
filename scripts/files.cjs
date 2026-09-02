'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_FILES = ['index.html', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', '.nojekyll'];
const PUBLIC_DIRECTORIES = ['css', 'js', 'imgs', 'vendor'];
const ASSET_EXTENSIONS = {
  css: new Set(['.css']),
  js: new Set(['.js']),
  imgs: new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']),
  vendor: new Set(['.css', '.js', '.woff', '.woff2', '.ttf'])
};

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function listFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links must not be published: ${target}`);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
    else throw new Error(`Unsupported file type: ${target}`);
  }
  return files;
}

function isPublicPath(relative) {
  const normalized = relative.split(path.sep).join('/');
  if (PUBLIC_FILES.includes(normalized)) return true;
  const segments = normalized.split('/');
  if (!PUBLIC_DIRECTORIES.includes(segments[0]) || segments.length < 2) return false;
  if (segments.some(segment => !segment || segment.startsWith('.') || segment.includes(':'))) return false;
  const fileName = segments.at(-1);
  if (normalized === 'vendor/manifest.json') return true;
  if (segments[0] === 'vendor' && ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].includes(fileName)) return true;
  return ASSET_EXTENSIONS[segments[0]].has(path.posix.extname(fileName).toLowerCase());
}

function getPublicFiles(root = PROJECT_ROOT) {
  const files = PUBLIC_FILES.map(relative => path.join(root, relative));
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`Required public file missing: ${file}`);
  }
  for (const directory of PUBLIC_DIRECTORIES) {
    const target = path.join(root, directory);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory()) throw new Error(`Required public directory missing: ${target}`);
    files.push(...listFiles(target));
  }
  for (const file of files) {
    if (!isPublicPath(path.relative(root, file))) throw new Error(`Unexpected file in public assets: ${file}`);
    if (!isWithin(fs.realpathSync(root), fs.realpathSync(file))) throw new Error(`Asset is outside project: ${file}`);
  }
  return files;
}

function resetGeneratedDirectory(name) {
  if (!['dist', 'vendor'].includes(name)) throw new Error('Only generated dist/vendor directories may be reset.');
  const root = fs.realpathSync(PROJECT_ROOT);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || !isWithin(root, target)) throw new Error('Unsafe generated directory path.');
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error('Refusing to replace a linked generated directory.');
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}

module.exports = { PROJECT_ROOT, PUBLIC_FILES, PUBLIC_DIRECTORIES, isWithin, listFiles, isPublicPath, getPublicFiles, resetGeneratedDirectory };
