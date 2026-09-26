const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

function fetchCookiesViaCDP(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 5000);
    const httpClient = net.createConnection({ port, host: '127.0.0.1' }, () => {
      httpClient.write(`GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let httpData = '';
    httpClient.on('data', chunk => { httpData += chunk.toString(); });
    httpClient.on('end', () => {
      try {
        const tabs = JSON.parse(httpData.slice(httpData.indexOf('\r\n\r\n') + 4));
        const tab = tabs.find(item => item.type === 'page') || tabs[0];
        if (!tab?.webSocketDebuggerUrl) { clearTimeout(timeout); reject(new Error('No debuggable tab')); return; }
        const wsPath = tab.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, '');
        const wsClient = net.createConnection({ port, host: '127.0.0.1' }, () => {
          const key = crypto.randomBytes(16).toString('base64');
          wsClient.write(`GET ${wsPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let handshakeDone = false;
        let wsBuffer = Buffer.alloc(0);

        function sendFrame(payload) {
          const data = Buffer.from(JSON.stringify(payload));
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(data);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
          let header;
          if (data.length < 126) { header = Buffer.alloc(6); header[0] = 0x81; header[1] = 0x80 | data.length; mask.copy(header, 2); }
          else if (data.length < 65536) { header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); mask.copy(header, 4); }
          else { header = Buffer.alloc(14); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); mask.copy(header, 10); }
          wsClient.write(Buffer.concat([header, masked]));
        }

        function parseFrames(buf) {
          const messages = [];
          let offset = 0;
          while (offset + 2 <= buf.length) {
            const b1 = buf[offset + 1];
            const isMasked = (b1 & 0x80) !== 0;
            let length = b1 & 0x7f;
            let headerLength = 2;
            if (length === 126) { if (offset + 4 > buf.length) break; length = buf.readUInt16BE(offset + 2); headerLength = 4; }
            else if (length === 127) { if (offset + 10 > buf.length) break; length = Number(buf.readBigUInt64BE(offset + 2)); headerLength = 10; }
            const maskLength = isMasked ? 4 : 0;
            const frameEnd = offset + headerLength + maskLength + length;
            if (frameEnd > buf.length) break;
            let payload = buf.slice(offset + headerLength + maskLength, frameEnd);
            if (isMasked) {
              const mask = buf.slice(offset + headerLength, offset + headerLength + 4);
              payload = Buffer.from(payload);
              for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            messages.push(payload.toString('utf8'));
            offset = frameEnd;
          }
          return { messages, remaining: buf.slice(offset) };
        }

        wsClient.on('data', chunk => {
          if (!handshakeDone) {
            const end = chunk.indexOf('\r\n\r\n');
            if (end < 0) return;
            handshakeDone = true;
            const rest = chunk.slice(end + 4);
            if (rest.length) wsBuffer = Buffer.concat([wsBuffer, rest]);
            sendFrame({ id: 1, method: 'Network.getAllCookies', params: {} });
            if (!wsBuffer.length) return;
          } else wsBuffer = Buffer.concat([wsBuffer, chunk]);

          const { messages, remaining } = parseFrames(wsBuffer);
          wsBuffer = remaining;
          for (const message of messages) {
            try {
              const response = JSON.parse(message);
              if (response.id === 1 && Array.isArray(response.result?.cookies)) {
                clearTimeout(timeout);
                wsClient.destroy();
                resolve(response.result.cookies);
                return;
              }
            } catch {}
          }
        });
        wsClient.on('error', error => { clearTimeout(timeout); reject(error); });
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
    httpClient.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

async function saveCookiesViaCDP(profileId, port, userDataDir, { fetchCookies = fetchCookiesViaCDP, store, send }) {
  const cookies = await fetchCookies(port);
  if (!Array.isArray(cookies)) return;

  const savePath = path.join(userDataDir, 'saved-cookies.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(savePath, JSON.stringify(cookies, null, 2), 'utf8');

  const profiles = store.get('profiles', []);
  const idx = profiles.findIndex(profile => profile.id === profileId);
  if (idx !== -1) {
    profiles[idx].cookieCount = cookies.length;
    profiles[idx].cookiesSavedAt = new Date().toISOString();
    profiles[idx].savedCookiesPath = savePath;
    store.set('profiles', profiles);
  }

  send('profile:cookiesSaved', { profileId, count: cookies.length, path: savePath });
}

module.exports = { fetchCookiesViaCDP, saveCookiesViaCDP };
