const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = req.url.split('?')[0];

  // API: Get Asset Manifest
  if (parsedUrl === '/api/assets' && req.method === 'GET') {
    if (fs.existsSync('assets-manifest.json')) {
      const data = fs.readFileSync('assets-manifest.json', 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(data);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Manifest not found' }));
    }
  }

  // API: Replace an asset via base64 JSON payload
  if (parsedUrl === '/api/replace-asset' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { targetPath, base64Data } = JSON.parse(body);
        if (!targetPath || !base64Data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing targetPath or base64Data' }));
        }

        const safeRelPath = targetPath.replace(/^[/\\]+/, '');
        const fullDest = path.join(__dirname, safeRelPath);

        // Security check
        if (!fullDest.startsWith(__dirname)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid destination path' }));
        }

        // Backup original if not already backed up
        const backupDest = fullDest + '.orig';
        if (fs.existsSync(fullDest) && !fs.existsSync(backupDest)) {
          fs.copyFileSync(fullDest, backupDest);
        }

        // Write new file
        const buffer = Buffer.from(base64Data.split(',').pop(), 'base64');
        fs.writeFileSync(fullDest, buffer);

        console.log(`[Asset Replaced] ${safeRelPath} (${buffer.length} bytes)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: `Asset ${safeRelPath} updated successfully!`,
          size: buffer.length
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Replace text content across index.html
  if (parsedUrl === '/api/replace-text' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { findText, replaceWith } = JSON.parse(body);
        if (!findText) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing findText' }));
        }

        let html = fs.readFileSync('index.html', 'utf8');
        const count = (html.split(findText).length - 1);
        html = html.split(findText).join(replaceWith);
        fs.writeFileSync('index.html', html, 'utf8');

        console.log(`[Text Replaced] "${findText}" -> "${replaceWith}" (${count} occurrences)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static file serving
  let reqPath = decodeURIComponent(parsedUrl);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  const filePath = path.join(__dirname, reqPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found: ' + reqPath);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const range = req.headers.range;
    if (range && (ext === '.mp4' || ext === '.webm')) {
      const parts = range.replace(/bytes=/, '').split('-');
      let start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;

      if (isNaN(start)) {
        start = stats.size - parseInt(parts[1], 10);
        end = stats.size - 1;
      }

      if (start >= stats.size || start > end || start < 0) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stats.size}`
        });
        return res.end();
      }

      end = Math.min(end, stats.size - 1);
      const chunksize = end - start + 1;

      try {
        const file = fs.createReadStream(filePath, { start, end });
        file.on('error', (err) => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType
        });
        file.pipe(res);
      } catch (streamErr) {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      const file = fs.createReadStream(filePath);
      file.on('error', () => { res.end(); });
      file.pipe(res);
    }
  });
});

process.on('uncaughtException', (err) => {
  console.error('[Server Error Caught]', err.message);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
