const http = require('http');
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');

const PORT = parseInt(process.env.PORT || '8080', 10);
const FILES_DIR = process.env.FILES_DIR || '/var/www/files';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

fs.mkdirSync(FILES_DIR, { recursive: true });

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function listFiles() {
  try {
    return fs.readdirSync(FILES_DIR)
      .filter(f => !f.startsWith('.'))
      .map(name => {
        const stat = fs.statSync(path.join(FILES_DIR, name));
        return {
          name,
          size: stat.size,
          sizeHuman: formatSize(stat.size),
          modified: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function safeName(raw) {
  return path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    sendJson(res, 200, { files: listFiles() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const name = safeName(url.pathname.slice(7));
    const filePath = path.join(FILES_DIR, name);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': stat.size
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    let totalBytes = 0;
    let fileName = '';
    let writeStream = null;
    let aborted = false;

    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE, files: 1 }
    });

    bb.on('file', (_fieldname, stream, info) => {
      fileName = safeName(info.filename);
      if (!fileName) {
        stream.resume();
        return;
      }
      const dest = path.join(FILES_DIR, fileName);
      writeStream = fs.createWriteStream(dest);

      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
      });

      stream.on('limit', () => {
        aborted = true;
        writeStream.destroy();
        try { fs.unlinkSync(path.join(FILES_DIR, fileName)); } catch {}
        sendJson(res, 413, { error: `File exceeds ${formatSize(MAX_FILE_SIZE)} limit` });
      });

      stream.pipe(writeStream);
    });

    bb.on('finish', () => {
      if (aborted) return;
      if (!fileName) {
        sendJson(res, 400, { error: 'No file provided' });
        return;
      }
      if (writeStream) {
        writeStream.on('close', () => {
          console.log(`Uploaded: ${fileName} (${formatSize(totalBytes)})`);
          sendJson(res, 200, { name: fileName, size: totalBytes, sizeHuman: formatSize(totalBytes) });
        });
      }
    });

    bb.on('error', (err) => {
      console.error('Upload error:', err.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'Upload failed' });
    });

    req.pipe(bb);
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/files/')) {
    const name = safeName(url.pathname.slice(11));
    const filePath = path.join(FILES_DIR, name);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    fs.unlinkSync(filePath);
    console.log(`Deleted: ${name}`);
    sendJson(res, 200, { deleted: name });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Artifact server listening on port ${PORT}`);
  console.log(`Serving files from ${FILES_DIR}`);
});
