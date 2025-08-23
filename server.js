const http = require('http');
const fs = require('fs');
const path = require('path');

// Maintain multiple chat rooms. Each room keeps its own password,
// connected clients (for SSE), message history and user locations.
// A room object has the form:
// { password: string, clients: Set<http.ServerResponse>, messages: Array, locations: { [userName: string]: { name, lat, lon, time } } }
const rooms = {};

/**
 * Get or create a room by name and optional password. If the room does not
 * exist, it will be created with the provided password. If it exists but
 * the password does not match, the function returns null to signal
 * authentication failure.
 *
 * @param {string} roomName The name of the room.
 * @param {string} password The password supplied by the client.
 * @returns {Object|null} The room object if authentication succeeds; null otherwise.
 */
function getOrCreateRoom(roomName, password) {
  // Normalize room name; default to 'default' if empty
  const name = roomName || 'default';
  const pwd = password || '';
  const room = rooms[name];
  if (room) {
    // Room exists; ensure passwords match
    if (room.password === pwd) {
      return room;
    }
    return null;
  }
  // Create a new room
  rooms[name] = {
    password: pwd,
    clients: new Set(),
    messages: [],
    locations: {},
  };
  return rooms[name];
}

/**
 * Broadcast an event to all clients in a specific room. If the room
 * does not exist, nothing happens.
 *
 * @param {string} roomName The name of the room.
 * @param {string} event The SSE event name (e.g. 'message', 'location', 'remove').
 * @param {Object} data The data to send with the event.
 */
function broadcast(roomName, event, data) {
  const room = rooms[roomName];
  if (!room) return;
  const payload = JSON.stringify(data);
  // Iterate over a copy to avoid modification during iteration
  for (const res of Array.from(room.clients)) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      // If writing fails the connection is likely closed; remove it below.
      room.clients.delete(res);
    }
  }
}

/**
 * Broadcast an event to all connected SSE clients.
 *
 * @param {string} event The event name to send to clients.
 * @param {Object} data The payload to transmit.
 */
// Note: the legacy global broadcast function and sseClients set were removed.
// We now use the room‑scoped broadcast(roomName, event, data) above to send
// messages to only the clients connected to a specific room.

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

  // Handle SSE endpoint for real‑time events within a specific room
  if (pathname === '/events') {
    const roomName = url.searchParams.get('room') || 'default';
    const password = url.searchParams.get('password') || '';
    const room = getOrCreateRoom(roomName, password);
    if (!room) {
      // Room exists but password mismatch
      res.writeHead(403);
      res.end('Invalid room password');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Send a blank line to establish the stream
    res.write('\n');
    // Send recent messages from this room
    room.messages.forEach((msg) => {
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    // Send current locations of this room
    Object.values(room.locations).forEach((loc) => {
      res.write(`event: location\n`);
      res.write(`data: ${JSON.stringify(loc)}\n\n`);
    });
    // Register this client in the room
    room.clients.add(res);
    // On close, remove client and clean up empty rooms
    req.on('close', () => {
      // Remove this client from the room's client set when the SSE connection
      // closes. We intentionally do **not** delete empty rooms here so that
      // rooms persist until explicitly deleted via the /deleteRoom endpoint.
      room.clients.delete(res);
    });
    return;
  }

  // Endpoint to post new chat messages (POST) – now includes room and password parameters in body
  if (pathname === '/message' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { name, text, room, password } = JSON.parse(body || '{}');
        const roomName = room || 'default';
        const roomObj = getOrCreateRoom(roomName, password || '');
        if (!roomObj) {
          res.writeHead(403);
          res.end('Invalid room password');
          return;
        }
        if (name && text) {
          const msg = { name, text, time: Date.now() };
          roomObj.messages.push(msg);
          // Trim the message history to avoid unbounded growth
          if (roomObj.messages.length > 200) roomObj.messages.shift();
          broadcast(roomName, 'message', msg);
        }
      } catch (err) {
        // Ignore malformed payloads
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

  // Endpoint to post location updates (POST) – includes room and password in body
  if (pathname === '/location' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { name, lat, lon, room, password } = JSON.parse(body || '{}');
        const roomName = room || 'default';
        const roomObj = getOrCreateRoom(roomName, password || '');
        if (!roomObj) {
          res.writeHead(403);
          res.end('Invalid room password');
          return;
        }
        if (name && typeof lat === 'number' && typeof lon === 'number') {
          const loc = { name, lat, lon, time: Date.now() };
          roomObj.locations[name] = loc;
          broadcast(roomName, 'location', loc);
        }
      } catch (err) {
        // Ignore malformed payloads
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

    
  // Endpoint to post new chat messages via GET (for platforms that disallow POST)
  if (pathname === '/message' && req.method === 'GET') {
    const roomName = url.searchParams.get('room') || 'default';
    const password = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name');
    const textParam = url.searchParams.get('text');
    const roomObj = getOrCreateRoom(roomName, password);
    if (!roomObj) {
      res.writeHead(403);
      res.end('Invalid room password');
      return;
    }
    if (name && textParam) {
      const msg = { name, text: textParam, time: Date.now() };
      roomObj.messages.push(msg);
      if (roomObj.messages.length > 200) roomObj.messages.shift();
      broadcast(roomName, 'message', msg);
    }
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Endpoint to post location updates via GET (for platforms that disallow POST)
  if (pathname === '/location' && req.method === 'GET') {
    const roomName = url.searchParams.get('room') || 'default';
    const password = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name');
    const latParam = parseFloat(url.searchParams.get('lat'));
    const lonParam = parseFloat(url.searchParams.get('lon'));
    const roomObj = getOrCreateRoom(roomName, password);
    if (!roomObj) {
      res.writeHead(403);
      res.end('Invalid room password');
      return;
    }
    if (name && !isNaN(latParam) && !isNaN(lonParam)) {
      const loc = { name, lat: latParam, lon: lonParam, time: Date.now() };
      roomObj.locations[name] = loc;
      broadcast(roomName, 'location', loc);
    }
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Endpoint to remove a user location (logout) via GET
  if (pathname === '/logout' && req.method === 'GET') {
    const roomName = url.searchParams.get('room') || 'default';
    const password = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name');
    const roomObj = getOrCreateRoom(roomName, password);
    if (!roomObj) {
      res.writeHead(403);
      res.end('Invalid room password');
      return;
    }
    if (name && roomObj.locations[name]) {
      delete roomObj.locations[name];
      // Broadcast a remove event so clients can delete the marker
      broadcast(roomName, 'remove', { name });
    }
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Endpoint to list available rooms
  if (pathname === '/rooms' && req.method === 'GET') {
    const list = Object.keys(rooms);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // Endpoint to delete a room
  if (pathname === '/deleteRoom' && req.method === 'GET') {
    const roomName = url.searchParams.get('room') || 'default';
    const password = url.searchParams.get('password') || '';
    const roomObj = rooms[roomName];
    if (!roomObj) {
      res.writeHead(404);
      res.end('Room not found');
      return;
    }

    // Endpoint to check whether a room exists and the password is correct.
    // Returns 404 if the room does not exist, 403 if the password is wrong,
    // and 200 if the password matches. This is used by the client to
    // validate the password before allowing the user to join an existing room.
    if (pathname === '/checkRoom' && req.method === 'GET') {
      const roomName = url.searchParams.get('room') || 'default';
      const password = url.searchParams.get('password') || '';
      const roomObj = rooms[roomName];
      if (!roomObj) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (roomObj.password !== password) {
        res.writeHead(403);
        res.end('invalid');
        return;
      }
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (roomObj.password !== password) {
      res.writeHead(403);
      res.end('Invalid room password');
      return;
    }
    // Only allow deletion if no clients are connected
    if (roomObj.clients.size > 0) {
      res.writeHead(409);
      res.end('Room has active clients');
      return;
    }
    delete rooms[roomName];
    res.writeHead(200);
    res.end('deleted');
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