'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT, getPublicFiles, listFiles, isWithin, isPublicPath } = require('./files.cjs');

const TRACKING = /sdk\.51\.la|hm\.baidu\.com|google-analytics\.com|googletagmanager\.com|cdn\.bootcdn\.net|LA_COLLECT/i;
const PAGES_BASE = 'https://example.github.io/Web-Serial-Debug/';

function assertAsset(reference, source, root, allowData = false) {
  if (!reference || reference.startsWith('#')) return;
  if (allowData && reference.startsWith('data:')) return;
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(reference)) throw new Error(`Assets must be local relative URLs: ${source} -> ${reference}`);
  const resolved = new URL(reference, new URL(source.replaceAll(path.sep, '/'), PAGES_BASE));
  if (!resolved.pathname.startsWith('/Web-Serial-Debug/')) throw new Error(`Asset escapes the Pages subdirectory: ${reference}`);
  const relative = decodeURIComponent(resolved.pathname.slice('/Web-Serial-Debug/'.length));
  const file = path.resolve(root, relative);
  if (!isPublicPath(path.relative(root, file))) throw new Error(`Asset is outside the publication allowlist: ${source} -> ${reference}`);
  if (!isWithin(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Missing local asset: ${source} -> ${reference}`);
  if (!isWithin(fs.realpathSync(root), fs.realpathSync(file))) throw new Error(`Linked external asset: ${reference}`);
}

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) values[match[1].toLowerCase()] = match[3];
  return values;
}

function checkProject(root = PROJECT_ROOT, options = {}) {
  const files = getPublicFiles(root);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if (!/<html\b[^>]*\blang\s*=\s*["']ko["']/i.test(html)) throw new Error('The page must declare lang="ko".');
  if (/<base\b/i.test(html)) throw new Error('Do not override relative GitHub Pages asset URLs with <base>.');
  const ids = new Set();
  for (const match of html.matchAll(/\bid\s*=\s*(["'])(.*?)\1/g)) {
    if (ids.has(match[2])) throw new Error(`Duplicate HTML id: ${match[2]}`);
    ids.add(match[2]);
  }
  for (const match of html.matchAll(/<(script|img|link|source|iframe|video|audio)\b[^>]*>/gi)) {
    const tag = attributes(match[0]);
    if (tag.src) assertAsset(tag.src, 'index.html', root);
    if (tag.poster) assertAsset(tag.poster, 'index.html', root);
    if (match[1].toLowerCase() === 'link' && tag.rel !== 'canonical' && tag.href) assertAsset(tag.href, 'index.html', root);
    if (tag.srcset) {
      for (const source of tag.srcset.split(',')) assertAsset(source.trim().split(/\s+/)[0], 'index.html', root);
    }
  }
  let inlineCount = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const tag = attributes(match[1]);
    if (!tag.src && (!tag.type || /(?:java|ecma)script/.test(tag.type))) new vm.Script(match[2], { filename: `index.html:inline-${++inlineCount}` });
  }
  for (const file of files) {
    const relative = path.relative(root, file);
    if (!/\.(?:html|css|js)$/.test(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (TRACKING.test(content)) throw new Error(`Third-party tracking/CDN reference in ${relative}.`);
    if (file.endsWith('.css')) {
      for (const match of content.matchAll(/\burl\(\s*(["']?)(.*?)\1\s*\)/gi)) assertAsset(match[2].trim(), relative, root, true);
      for (const match of content.matchAll(/@import\s+(["'])(.*?)\1/gi)) assertAsset(match[2], relative, root);
    }
  }
  if (options.syntax !== false) {
    const syntaxFiles = files.filter(file => file.endsWith('.js'));
    if (path.resolve(root) === PROJECT_ROOT) syntaxFiles.push(...listFiles(path.join(root, 'scripts')).filter(file => /\.[cm]?js$/.test(file)));
    for (const file of syntaxFiles) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`JavaScript syntax error in ${path.relative(root, file)}:\n${result.stderr || result.error}`);
    }
  }
  console.log(`Checked ${files.length} public files: Korean document, unique IDs, JavaScript syntax, local assets, and tracking guard.`);
  return files;
}

if (require.main === module) checkProject();
module.exports = { assertAsset, checkProject };
