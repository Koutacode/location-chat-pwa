const http = require('http');
const fs = require('fs');
const path = require('path');

// Array to hold Server‑Sent Events clients
const sseClients = [];

// Keep a list of recent chat messages and current user locations
const messages = [];
const locations = {};

/**
 * Broadcast an event to all connected SSE clients.
 *
 * @param {string} event The event name to send to clients.
 * @param {Object} data The payload to transmit.
 */
function broadcast(event, data) {
  const payload = JSON.stringify(data);
  sseClients.forEach((res) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      // If writing fails the connection is likely closed; remove it below.
    }
  });
}

/**
 * Serve static files from the public directory. If the file does not exist
 * return a 404.
 *
 * @param {string} filePath Resolved absolute path to a file in public.
 * @param {http.ServerResponse} res Response object to write to.
 */
function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // Basic MIME type map; extend as needed
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

/**
 * Create the HTTP server. This handles SSE connections, message and
 * location updates, and serves static files from the public directory.
 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Handle SSE endpoint for real‑time events
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send a blank line to establish the stream
    res.write('\n');
    // Send recent messages so new clients have some context
    messages.forEach((msg) => {
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    // Send current locations so new clients immediately see markers
    Object.values(locations).forEach((loc) => {
      res.write(`event: location\n`);
      res.write(`data: ${JSON.stringify(loc)}\n\n`);
    });
    sseClients.push(res);
    // Remove client on connection close
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  // Endpoint to post new chat messages
  if (pathname === '/message' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { name, text } = JSON.parse(body || '{}');
        if (name && text) {
          const msg = { name, text, time: Date.now() };
          messages.push(msg);
          // Trim the message history to avoid unbounded growth
          if (messages.length > 200) messages.shift();
          broadcast('message', msg);
        }
      } catch (err) {
        // Ignore malformed payloads
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

  // Endpoint to post location updates
  if (pathname === '/location' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { name, lat, lon } = JSON.parse(body || '{}');
        if (name && typeof lat === 'number' && typeof lon === 'number') {
          const loc = { name, lat, lon, time: Date.now() };
          locations[name] = loc;
          broadcast('location', loc);
        }
      } catch (err) {
        // Ignore malformed payloads
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

    // Serve static files from the project root rather than a dedicated
  // `public` directory. By using the project root as the static
  // directory, we can deploy the application to platforms like
  // Render without needing to create a nested "public" folder in the
  // repository. The `pathname` begins with a forward slash, so
  // substring(1) strips it. If the request targets the root path
  // ("/"), fall back to serving index.html.
  const staticDir = __dirname;
  // Build an absolute file path based on the requested pathname.
  let filePath = path.join(staticDir, pathname === '/' ? 'index.html' : pathname.substring(1));
  // For security, ensure the resolved path still resides within the
  // staticDir. If not, block the request to prevent directory traversal.
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveStatic(filePath, res);

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Location chat server running on http://localhost:${PORT}`);
});