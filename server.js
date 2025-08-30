const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// ルーム情報の管理
const rooms = Object.create(null);
// 招待トークン管理
const invites = Object.create(null);

// SSE用ヘッダ
function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  };
}

// SSE送信
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 静的ファイル配信
function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    const type =
      ext === '.html' ? 'text/html' :
      ext === '.css'  ? 'text/css' :
      ext === '.js'   ? 'text/javascript' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ルーム一覧取得
  if (pathname === '/rooms' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.keys(rooms)));
    return;
  }

  // メッセージ送信
  if (pathname === '/message' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const pass = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name') || '';
    const text = url.searchParams.get('text') || '';
    const r = rooms[room];
    if (!r || r.password !== pass) { res.writeHead(403); res.end('Forbidden'); return; }
    const msg = { name, text, time: Date.now() };
    for (const client of r.clients) sseSend(client, 'message', msg);
    res.writeHead(204); res.end(); return;
  }

  // 位置情報送信
  if (pathname === '/location' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const pass = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name') || '';
    const lat  = parseFloat(url.searchParams.get('lat'));
    const lon  = parseFloat(url.searchParams.get('lon'));
    const r = rooms[room];
    if (!r || r.password !== pass) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { res.writeHead(400); res.end('Bad Request'); return; }

    r.markers.set(name, { lat, lon });
    for (const client of r.clients) sseSend(client, 'location', { name, lat, lon });
    res.writeHead(204); res.end(); return;
  }

  // ログアウト（マーカー削除）
  if (pathname === '/logout' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const pass = url.searchParams.get('password') || '';
    const name = url.searchParams.get('name') || '';
    const r = rooms[room];
    if (!r || r.password !== pass) { res.writeHead(403); res.end('Forbidden'); return; }
    r.markers.delete(name);
    for (const client of r.clients) sseSend(client, 'remove', { name });
    res.writeHead(204); res.end(); return;
  }

  // 招待リンク生成
  if (pathname === '/invite/create' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const pass = url.searchParams.get('password') || '';
    let r = rooms[room];
    if (!r) {
      r = rooms[room] = { password: pass || '', clients: new Set(), markers: new Map(), messages: [] };
    } else if (pass) {
      r.password = pass;  // パスワード更新
    }
    const token = Math.random().toString(36).slice(2);
    invites[token] = { room, password: r.password };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ link: `/invite?token=${token}` }));
    return;
  }

  // 招待トークン引換（JSON）
  if (pathname === '/invite/join' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const info = invites[token];
    if (!token || !info) { res.writeHead(404); res.end('Invalid token'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ room: info.room, password: info.password }));
    return;
  }

  // /invite?token=... : ブラウザからは index.html を返す
  if (pathname === '/invite' && req.method === 'GET') {
    const accept = String(req.headers['accept'] || '');
    if (accept.includes('text/html')) {
      serveStatic(path.join(__dirname, 'index.html'), res);
      return;
    }
    // プログラムアクセスの場合は /invite/join へ
    const token = url.searchParams.get('token') || '';
    res.writeHead(302, { Location: `/invite/join?token=${encodeURIComponent(token)}` });
    res.end(); return;
  }

  // SSE: /events
  if (pathname === '/events' && req.method === 'GET') {
    const room = url.searchParams.get('room') || '';
    const pass = url.searchParams.get('password') || '';
    let r = rooms[room];
    if (!r) {
      r = rooms[room] = { password: pass || '', clients: new Set(), markers: new Map(), messages: [] };
    }
    if (r.password !== pass) { res.writeHead(403); res.end('Forbidden'); return; }
    // ヘッダと接続
    res.writeHead(200, sseHeaders());
    res.write('\n');
    r.clients.add(res);
    req.on('close', () => {
      r.clients.delete(res);
    });
    // 既存マーカーを初期送信
    for (const [name, pos] of r.markers.entries()) {
      sseSend(res, 'location', { name, lat: pos.lat, lon: pos.lon });
    }
    return;
  }

  // 静的ファイル: index.html, style.css, main.js
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(path.join(__dirname, 'index.html'), res); return;
  }
  if (pathname === '/style.css') {
    serveStatic(path.join(__dirname, 'style.css'), res); return;
  }
  if (pathname === '/main.js') {
    serveStatic(path.join(__dirname, 'main.js'), res); return;
  }

  // それ以外は404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
