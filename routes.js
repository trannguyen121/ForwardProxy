const express = require('express');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const axios = require('axios');
const path = require('path');
const { HttpProxyAgent } = require('http-proxy-agent');
const { URL } = require('url');

const router = express.Router();

let proxies = [];
let forwardServers = [];

function getLocalLANIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function buildProxyComponents(proxyStr) {
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    const [ip, port, user, pass] = parts;
    return { ip, port, user, pass };
  } else if (parts.length === 2) {
    const [ip, port] = parts;
    return { ip, port };
  }
  return null;
}

function startForwardServers() {
  forwardServers.forEach(s => s.close());
  forwardServers = [];
  const lanIP = getLocalLANIP();

  proxies.forEach((proxyStr, i) => {
    const proxy = buildProxyComponents(proxyStr);
    if (!proxy) return;

    const port = 20001 + i;
    const proxyUrl = proxy.user
      ? `http://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@${proxy.ip}:${proxy.port}`
      : `http://${proxy.ip}:${proxy.port}`;
    const target = new URL(proxyUrl);

    const httpServer = http.createServer((req, res) => {
      const agent = new HttpProxyAgent(proxyUrl);
      const options = {
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: agent,
      };

      const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
  console.error('⚠️ proxyReq error:', err.code);
  res.writeHead(502);
  res.end('Bad gateway');
});

req.on('error', err => {
  console.error('⚠️ req stream error:', err.code);
});

      req.pipe(proxyReq);
    });

    httpServer.on('connect', (req, clientSocket, head) => {
      const [host, port] = req.url.split(':');
      const authHeader = proxy.user
        ? 'Proxy-Authorization: Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64') + '\r\n'
        : '';

      const connectSocket = net.connect(proxy.port, proxy.ip, () => {
        connectSocket.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          authHeader +
          `Connection: keep-alive\r\n\r\n`
        );

        connectSocket.once('data', (data) => {
          if (data.toString().includes('200')) {
            clientSocket.write(data);
            connectSocket.write(head);
            clientSocket.pipe(connectSocket);
            connectSocket.pipe(clientSocket);
          } else {
            clientSocket.end();
            connectSocket.end();
          }
        });
      });

      connectSocket.on('error', (err) => {
  console.error(`❌ Proxy ${proxyStr} bị ngắt (${err.code}) → reset forwarding...`);
  setTimeout(startForwardServers, 1000);
  clientSocket.destroy();
});

clientSocket.on('error', (err) => {
  console.error(`⚠️ Client socket error: ${err.code}`);
});
    });

    httpServer.listen(port, () => {
      console.log(`Forward ${proxyStr} => http://${lanIP}:${port}`);
    });

    forwardServers.push(httpServer);
  });
}

router.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'views/index.html'), 'utf8');
  res.send(html.replace('${proxyRows}', ''));
});

router.post('/upload', async (req, res) => {
  let raw = req.body.proxies;
  proxies = raw.split("\n").map(line => line.trim()).filter(line => line);
  fs.writeFileSync('proxies.txt', proxies.join("\n"));
  startForwardServers();

  const lanIP = getLocalLANIP();
  const results = await Promise.all(
    proxies.map(async (proxyStr, idx) => {
      const proxy = buildProxyComponents(proxyStr);
      const forwardAddr = `${lanIP}:${20001 + idx}`;
      if (!proxy) return { origin: proxyStr, forward: forwardAddr, ip: '❌ Invalid Format' };

      const proxyUrl = proxy.user
        ? `http://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@${proxy.ip}:${proxy.port}`
        : `http://${proxy.ip}:${proxy.port}`;

      try {
        const agent = new HttpProxyAgent(proxyUrl);
        const response = await axios.get('http://httpbin.org/ip', { httpAgent: agent, timeout: 8000 });
        return { origin: proxyStr, forward: forwardAddr, ip: response.data.origin };
      } catch (err) {
        return { origin: proxyStr, forward: forwardAddr, ip: `❌ ${err.code || err.message}` };
      }
    })
  );

  const rowsHTML = results.map((r, i) => `
    <tr>
      <td class="border px-4 py-2 text-center">${i + 1}</td>
      <td class="border px-4 py-2 text-center">
        <label class="ios-checkbox red">
          <input type="checkbox" name="proxy" value="${i}">
          <div class="checkbox-wrapper">
            <div class="checkbox-bg"></div>
            <svg viewBox="0 0 24 24" fill="none" class="checkbox-icon">
              <path d="M5 13l4 4L19 7" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="check-path"/>
            </svg>
          </div>
        </label>
      </td>
      <td class="border px-4 py-2">${r.origin}</td>
      <td class="border px-4 py-2">${r.forward}</td>
      <td class="border px-4 py-2">${r.ip}</td>
    </tr>`).join('');

  let html = fs.readFileSync(path.join(__dirname, 'views/index.html'), 'utf8');
  html = html.replace('${proxyRows}', rowsHTML);
  res.send(html);
});

router.get('/export-local', (req, res) => {
  const lanIP = getLocalLANIP();
  const content = proxies.map((_, i) => `${lanIP}:${20001 + i}`).join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=forwarded_proxies.txt');
  res.setHeader('Content-Type', 'text/plain');
  res.send(content);
});

router.get('/clear', (req, res) => {
  proxies = [];
  forwardServers.forEach(s => s.close());
  forwardServers = [];
  fs.writeFileSync('proxies.txt', '');
  res.redirect('/');
});

router.post('/recheck', async (req, res) => {
  try {
    const { indexes } = req.body;
    const lanIP = getLocalLANIP();
    const checkList = indexes.map(i => parseInt(i)).filter(i => proxies[i]);

    await Promise.all(checkList.map(async i => {
      const proxy = buildProxyComponents(proxies[i]);
      const proxyUrl = proxy.user
        ? `http://${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@${proxy.ip}:${proxy.port}`
        : `http://${proxy.ip}:${proxy.port}`;
      const agent = new HttpProxyAgent(proxyUrl);
      try {
        const response = await axios.get('http://httpbin.org/ip', { httpAgent: agent, timeout: 8000 });
        console.log(`✅ Proxy ${i} live: ${response.data.origin}`);
      } catch (err) {
        console.log(`❌ Proxy ${i} error: ${err.code || err.message}`);
      }
    }));
  } catch (e) {
    console.log('Recheck failed:', e);
  }
  res.end();
});

module.exports = router;
