const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');

let listener;
let port;

test.before(async () => {
  await new Promise((resolve) => {
    listener = server.listen(0, () => {
      port = listener.address().port;
      resolve();
    });
  });
});

test.after(() => new Promise((resolve) => listener.close(resolve)));

test('message and location endpoints', async () => {
  const base = `http://localhost:${port}`;
  let res = await fetch(`${base}/message?room=room1&password=pass&name=Bob&text=Hi`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');

  res = await fetch(`${base}/location?room=room1&password=pass&name=Bob&lat=1&lon=2`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('invite flow limits usage', async () => {
  const base = `http://localhost:${port}`;
  await fetch(`${base}/message?room=room2&password=pass&name=Alice&text=Hi`);

  const inviteRes = await fetch(`${base}/invite/create?room=room2&password=pass&expiry=1&maxUses=2`);
  assert.equal(inviteRes.status, 200);
  const { token } = await inviteRes.json();

  let res = await fetch(`${base}/invite?token=${token}`);
  assert.equal(res.status, 200);

  res = await fetch(`${base}/invite?token=${token}`);
  assert.equal(res.status, 200);

  res = await fetch(`${base}/invite?token=${token}`);
  assert.equal(res.status, 404);
});

test('deleteRoom removes room', async () => {
  const base = `http://localhost:${port}`;
  await fetch(`${base}/message?room=room3&password=pass&name=Alice&text=Hi`);

  let res = await fetch(`${base}/deleteRoom?room=room3&password=pass`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'deleted');

  res = await fetch(`${base}/checkRoom?room=room3&password=pass`);
  assert.equal(res.status, 404);
});

test('SSE streams history and logout broadcasts removal', async () => {
  const base = `http://localhost:${port}`;
  // Preload history then connect to SSE and verify it is delivered
  await fetch(`${base}/message?room=sse&password=pass&name=Bob&text=Hello`);
  await fetch(`${base}/location?room=sse&password=pass&name=Bob&lat=1&lon=2`);

  const controller = new AbortController();
  const res = await fetch(`${base}/events?room=sse&password=pass`, { signal: controller.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!buf.includes('event: location')) {
    const { done, value } = await reader.read();
    assert.ok(!done, 'stream ended before delivering history');
    buf += dec.decode(value);
  }
  assert.match(buf, /event: message\ndata:.*"text":"Hello"/);
  assert.match(buf, /event: location\ndata:.*"lat":1/);

  // Now test live broadcast and logout removal
  buf = '';
  await fetch(`${base}/location`, {
    method: 'POST',
    body: JSON.stringify({ room: 'sse', password: 'pass', name: 'Bob', lat: 3, lon: 4 })
  });
  while (!buf.includes('event: location')) {
    const { done, value } = await reader.read();
    assert.ok(!done, 'stream ended before location broadcast');
    buf += dec.decode(value);
  }
  assert.match(buf, /event: location\ndata:.*"lat":3/);

  buf = '';
  await fetch(`${base}/logout?room=sse&password=pass&name=Bob`);
  while (!buf.includes('event: remove')) {
    const { done, value } = await reader.read();
    assert.ok(!done, 'stream ended before remove broadcast');
    buf += dec.decode(value);
  }
  assert.match(buf, /event: remove\ndata:.*"name":"Bob"/);
  controller.abort();
});

test('rooms listing and password checks', async () => {
  const base = `http://localhost:${port}`;
  await fetch(`${base}/message?room=listRoom&password=secret&name=Bob&text=Hi`);

  let res = await fetch(`${base}/rooms`);
  assert.equal(res.status, 200);
  const rooms = await res.json();
  assert.ok(rooms.includes('listRoom'));

  res = await fetch(`${base}/checkRoom?room=listRoom&password=secret`);
  assert.equal(res.status, 200);

  res = await fetch(`${base}/checkRoom?room=listRoom&password=wrong`);
  assert.equal(res.status, 403);

  res = await fetch(`${base}/checkRoom?room=doesNotExist&password=whatever`);
  assert.equal(res.status, 404);
});

