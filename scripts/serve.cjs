'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PROJECT_ROOT, isWithin, isPublicPath } = require('./files.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function createStaticServer({ root = PROJECT_ROOT, basePath = '/Web-Serial-Debug-KR/' } = {}) {
  const publicRoot = fs.realpathSync(path.resolve(root));
  const base = `/${basePath.split('/').filter(Boolean).join('/')}/`.replace('//', '/');
  return http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return reply(405, 'Method not allowed');
    }
    let pathname;
    try {
      pathname = decodeURIComponent((request.url || '/').split('?')[0]);
    } catch {
      return reply(400, 'Invalid URL');
    }
    if (!pathname.startsWith('/') || /[\\\u0000-\u001f\u007f:]/.test(pathname) || pathname.split('/').some(segment => segment === '..' || segment === '.')) return reply(403, 'Forbidden');
    if (base !== '/' && pathname === base.slice(0, -1)) {
      response.writeHead(308, { Location: base });
      return response.end();
    }
    if (pathname.startsWith(base)) pathname = pathname.slice(base.length);
    else pathname = pathname.slice(1);
    const relative = pathname === '' ? 'index.html' : pathname;
    if (!isPublicPath(relative)) return reply(404, 'Not found');
    const file = path.resolve(publicRoot, relative);
    if (!isWithin(publicRoot, file)) return reply(403, 'Forbidden');
    try {
      if (!fs.statSync(file).isFile() || !isWithin(publicRoot, fs.realpathSync(file))) return reply(404, 'Not found');
      const size = fs.statSync(file).size;
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8',
        'Content-Length': size
      });
      if (request.method === 'HEAD') return response.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      return reply(['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? 404 : 500, 'Not found');
    }
  });
}

function readArguments(args) {
  const options = { root: PROJECT_ROOT, basePath: '/Web-Serial-Debug-KR/', host: '127.0.0.1', port: 4173 };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--root', '--base', '--host', '--port'].includes(name) || !value) throw new Error('Usage: npm run dev -- [--root dist] [--base /Web-Serial-Debug-KR/] [--host 127.0.0.1] [--port 4173]');
    if (name === '--root') options.root = path.resolve(PROJECT_ROOT, value);
    if (name === '--base') options.basePath = value;
    if (name === '--host') options.host = value;
    if (name === '--port') options.port = Number(value);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be an integer from 1 through 65535.');
  return options;
}

if (require.main === module) {
  const options = readArguments(process.argv.slice(2));
  const server = createStaticServer(options);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(options.port, options.host, () => console.log(`Web Serial Debug KR: http://${options.host}:${options.port}${options.basePath}\nServing public files only from ${options.root}. Press Ctrl+C to stop.`));
}

module.exports = { createStaticServer, readArguments };
