// ==================== 暑假打卡同步服务器 ====================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 18930;
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, '暑假日程规划.html');

// WebSocket 简易实现（基于 HTTP 升级）
const clients = new Map(); // clientId -> {ws, nick}

// ===== 数据存储 =====
let store = { checks: {}, names: {}, colors: {}, customTasks: [] };
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch(e) { console.error('Load data error:', e.message); }
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch(e) { console.error('Save data error:', e.message); }
}
loadData();

// ===== HTTP 服务器 =====
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // API: 获取全部数据
  if (url.pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store));
    return;
  }

  // API: 保存数据
  if (url.pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        Object.keys(updates).forEach(key => {
          if (key in store) store[key] = updates[key];
        });
        saveData();
        // 广播给其他客户端
        broadcast({ type: 'sync', data: store, source: req.headers['x-client-id'] || '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 提供静态文件
  const filePath = url.pathname === '/' ? HTML_FILE : path.join(__dirname, url.pathname);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===== WebSocket 处理 =====
server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB9A11E30C3')
    .digest('base64');

  const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  clients.set(clientId, { ws: socket, nick: '' });

  console.log('Client connected:', clientId, 'Total:', clients.size);

  // 发送当前数据
  sendWS(socket, { type: 'init', clientId: clientId, data: store });

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const firstByte = buf[0];
      const secondByte = buf[1];
      const opcode = firstByte & 0x0F;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = buf.readBigUInt64BE(2);
        offset = 10;
      }

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.slice(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + payloadLen) return;

      let payload;
      if (mask) {
        payload = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = buf[offset + i] ^ mask[i % 4];
        }
      } else {
        payload = buf.slice(offset, offset + payloadLen);
      }

      buf = buf.slice(offset + payloadLen);

      if (opcode === 0x08) {
        // Close
        clients.delete(clientId);
        console.log('Client disconnected:', clientId, 'Total:', clients.size);
        return;
      }

      if (opcode === 0x01) {
        // Text message
        try {
          const msg = JSON.parse(payload.toString());
          handleMessage(clientId, socket, msg);
        } catch(e) {
          console.error('Parse error:', e.message);
        }
      }
    }
  });

  socket.on('close', () => {
    clients.delete(clientId);
    console.log('Client disconnected:', clientId, 'Total:', clients.size);
  });
});

function handleMessage(clientId, socket, msg) {
  switch (msg.type) {
    case 'save':
      // 保存数据到 store
      Object.keys(msg.data || {}).forEach(key => {
        if (['checks', 'names', 'colors', 'customTasks'].includes(key)) {
          store[key] = msg.data[key];
        }
      });
      saveData();
      // 广播给所有其他客户端
      broadcast({ type: 'sync', data: store, source: clientId }, clientId);
      break;
    case 'ping':
      sendWS(socket, { type: 'pong' });
      break;
  }
}

function broadcast(msg, excludeClientId) {
  clients.forEach((client, id) => {
    if (id !== excludeClientId) {
      try { sendWS(client.ws, msg); } catch(e) {}
    }
  });
}

function sendWS(socket, data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf-8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('================================================');
  console.log('  暑假打卡同步服务器已启动');
  console.log('  本地访问: http://localhost:' + PORT);
  console.log('  局域网访问: http://' + getLocalIP() + ':' + PORT);
  console.log('================================================');
});

function getLocalIP() {
  try {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (let name in interfaces) {
      for (let iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch(e) {}
  return '127.0.0.1';
}
