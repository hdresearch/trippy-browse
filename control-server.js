import http from 'http';
import https from 'https';
import { URL } from 'url';
import { readFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import zlib from 'zlib';

const PORT = 3000;
const CHROME_DEBUG_PORT = 9222;
const SCREENCAST_QUALITY = 75;
const PROXY_ORIGIN = `http://127.0.0.1:${PORT}`;

// ---- CSS injected into every proxied page ----
const INJECT_CSS = `
  * { text-shadow: 0 0 1px rgba(100,200,255,0.12) !important; }
  ::selection { background: rgba(120,80,255,0.4) !important; }
`;

// ---- State ----
let cdpWs = null;
let cdpMsgId = 0;
let cdpPending = new Map();
let currentUrl = 'about:blank'; // The real URL (not proxied)
let currentTitle = '';
let latestFrame = null;

// ==================== REVERSE PROXY ====================

// Convert a real URL to a proxied URL
// https://lobste.rs/s/abc → /p/https/lobste.rs/s/abc
function toProxyUrl(realUrl) {
    try {
        const u = new URL(realUrl);
        return `/p/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}${u.hash}`;
    } catch (e) {
        return realUrl;
    }
}

// Convert a proxied path back to a real URL
// /p/https/lobste.rs/s/abc → https://lobste.rs/s/abc
function fromProxyPath(path) {
    const m = path.match(/^\/p\/(https?)\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    return `${m[1]}://${m[2]}${m[3] || '/'}`;
}

// Resolve a potentially relative URL against a base, then convert to proxy URL
function rewriteUrl(href, baseUrl) {
    if (!href || href.startsWith('data:') || href.startsWith('blob:') || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) {
        return href;
    }
    try {
        const resolved = new URL(href, baseUrl).href;
        return toProxyUrl(resolved);
    } catch (e) {
        return href;
    }
}

// Rewrite URLs in HTML content
function rewriteHtml(html, baseUrl) {
    // Rewrite href, src, action, poster, srcset attributes
    let result = html.replace(/((?:href|src|action|poster|formaction)\s*=\s*)(["'])([^"']*?)\2/gi, (match, prefix, quote, url) => {
        return `${prefix}${quote}${rewriteUrl(url.trim(), baseUrl)}${quote}`;
    });

    // Rewrite srcset
    result = result.replace(/(srcset\s*=\s*)(["'])([^"']*?)\2/gi, (match, prefix, quote, srcset) => {
        const rewritten = srcset.split(',').map(entry => {
            const parts = entry.trim().split(/\s+/);
            if (parts[0]) parts[0] = rewriteUrl(parts[0], baseUrl);
            return parts.join(' ');
        }).join(', ');
        return `${prefix}${quote}${rewritten}${quote}`;
    });

    // Rewrite url() in inline styles
    result = result.replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi, (match, quote, url) => {
        return `url(${quote}${rewriteUrl(url.trim(), baseUrl)}${quote})`;
    });

    // Rewrite <meta http-equiv="refresh" content="0;url=...">
    result = result.replace(/(content\s*=\s*["']\d+\s*;\s*url\s*=\s*)([^"']+)/gi, (match, prefix, url) => {
        return `${prefix}${rewriteUrl(url.trim(), baseUrl)}`;
    });

    // Inject our custom CSS
    result = result.replace('</head>', `<style>${INJECT_CSS}</style></head>`);

    // Inject comprehensive URL rewriting script
    // Extract the target origin from baseUrl so the script knows how to rewrite
    let baseOrigin = '';
    try { const u = new URL(baseUrl); baseOrigin = u.origin; } catch(e) {}

    const proxyScript = `<script>
    (function() {
      var BASE_ORIGIN = ${JSON.stringify(baseOrigin)};
      var PROXY_PREFIX = '/p/';

      function toProxy(url) {
        if (!url || url.startsWith('/p/') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('mailto:')) return url;
        try {
          // Resolve relative URLs against the real origin
          var abs;
          if (url.startsWith('//')) abs = location.protocol + url;
          else if (url.startsWith('/')) abs = BASE_ORIGIN + url;
          else if (/^https?:\\/\\//.test(url)) abs = url;
          else return url; // relative path — already handled by proxy since page is served from /p/...
          var u = new URL(abs);
          return '/p/' + u.protocol.replace(':', '') + '/' + u.host + u.pathname + u.search + u.hash;
        } catch(e) { return url; }
      }

      // Intercept link clicks
      document.addEventListener('click', function(e) {
        var a = e.target.closest('a');
        if (!a || !a.href) return;
        var href = a.getAttribute('href');
        if (!href || href.startsWith('/p/') || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
        var proxied = toProxy(href);
        if (proxied !== href) {
          e.preventDefault();
          location.href = proxied;
        }
      }, true);

      // Intercept form submissions
      document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form.action) {
          var proxied = toProxy(form.action);
          if (proxied !== form.action) form.action = proxied;
        }
      }, true);

      // Intercept history.pushState / replaceState
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function(s, t, url) { return origPush.call(this, s, t, url ? toProxy(url) : url); };
      history.replaceState = function(s, t, url) { return origReplace.call(this, s, t, url ? toProxy(url) : url); };

      // Intercept window.location assignments
      var origAssign = location.assign;
      var origReplace2 = location.replace;
      if (origAssign) location.assign = function(url) { return origAssign.call(location, toProxy(url)); };
      if (origReplace2) location.replace = function(url) { return origReplace2.call(location, toProxy(url)); };

      // Intercept window.open
      var origOpen = window.open;
      window.open = function(url, target, features) { return origOpen.call(window, url ? toProxy(url) : url, target, features); };

      // Intercept fetch
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string') input = toProxy(input);
        else if (input instanceof Request) input = new Request(toProxy(input.url), input);
        return origFetch.call(window, input, init);
      };

      // Intercept XMLHttpRequest.open
      var origXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        arguments[1] = toProxy(url);
        return origXhrOpen.apply(this, arguments);
      };
    })();
    </script>`;
    result = result.replace('<head>', `<head>${proxyScript}`);

    return result;
}

// Rewrite URLs in CSS content
function rewriteCss(css, baseUrl) {
    return css.replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi, (match, quote, url) => {
        if (url.startsWith('data:')) return match;
        return `url(${quote}${rewriteUrl(url.trim(), baseUrl)}${quote})`;
    });
}

// Fetch a URL and pipe it back as a proxy response
function proxyRequest(realUrl, req, res) {
    const parsed = new URL(realUrl);
    const proto = parsed.protocol === 'https:' ? https : http;

    const proxyReq = proto.request(parsed, {
        method: req.method,
        headers: {
            ...req.headers,
            host: parsed.host,
            referer: realUrl,
            origin: parsed.origin,
            // Remove our proxy-specific headers
            'accept-encoding': 'gzip, deflate',
        },
        timeout: 30000,
        rejectUnauthorized: false, // ignore TLS cert errors — experimental demo only
    }, (proxyRes) => {
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');
        const needsRewrite = isHtml || isCss;

        // Strip security headers that break proxying
        const headers = { ...proxyRes.headers };
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['x-frame-options'];
        delete headers['x-content-type-options'];
        delete headers['strict-transport-security'];
        delete headers['permissions-policy'];
        delete headers['cross-origin-embedder-policy'];
        delete headers['cross-origin-opener-policy'];
        delete headers['cross-origin-resource-policy'];

        // Rewrite Location header for redirects
        if (headers.location) {
            try {
                const absLocation = new URL(headers.location, realUrl).href;
                headers.location = toProxyUrl(absLocation);
            } catch (e) {}
        }

        // Rewrite Set-Cookie domain/path
        if (headers['set-cookie']) {
            const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
            headers['set-cookie'] = cookies.map(c =>
                c.replace(/;\s*domain=[^;]*/gi, '')
                 .replace(/;\s*secure/gi, '')
                 .replace(/;\s*samesite=[^;]*/gi, '; SameSite=Lax')
            );
        }

        if (needsRewrite) {
            // Collect full body, rewrite, send
            delete headers['content-length'];
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];

            const chunks = [];
            let stream = proxyRes;

            // Decompress if needed
            const encoding = proxyRes.headers['content-encoding'];
            if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
            else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
            else if (encoding === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

            stream.on('data', d => chunks.push(d));
            stream.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf-8');
                if (isHtml) body = rewriteHtml(body, realUrl);
                else if (isCss) body = rewriteCss(body, realUrl);

                headers['content-length'] = Buffer.byteLength(body);
                res.writeHead(proxyRes.statusCode, headers);
                res.end(body);
            });
            stream.on('error', () => { res.writeHead(502); res.end('Proxy error'); });
        } else {
            // Pass through without rewriting
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (e) => {
        console.error(`[proxy] Error fetching ${realUrl}: ${e.message}`);
        res.writeHead(502);
        res.end(`Proxy error: ${e.message}`);
    });

    // Forward request body for POST
    req.pipe(proxyReq);
}

// ==================== CDP ====================

async function connectCDP() {
    const resp = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list`);
    const tabs = await resp.json();
    if (!tabs[0]) throw new Error('No tabs');
    return new Promise((resolve, reject) => {
        cdpWs = new WebSocket(tabs[0].webSocketDebuggerUrl);
        cdpWs.on('open', () => { console.log('[cdp] Connected'); resolve(); });
        cdpWs.on('message', handleCDPMessage);
        cdpWs.on('close', () => { cdpWs = null; });
        cdpWs.on('error', reject);
    });
}

function cdpSend(method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return reject(new Error('CDP disconnected'));
        const id = ++cdpMsgId;
        cdpPending.set(id, { resolve, reject });
        cdpWs.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (cdpPending.has(id)) { cdpPending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });
}

function handleCDPMessage(raw) {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined && cdpPending.has(msg.id)) {
        const { resolve, reject } = cdpPending.get(msg.id);
        cdpPending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        return;
    }

    if (msg.method === 'Page.screencastFrame') {
        latestFrame = msg.params.data;
        cdpSend('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
        broadcastFrame(latestFrame);
    }

    // Shell page itself navigated (only on startup)
    if (msg.method === 'Page.frameNavigated') {
        const { frame } = msg.params;
        if (!frame.parentId) {
            console.log(`[cdp] Main frame: ${frame.url}`);
        }
    }
}

// ---- Fetch page HTML through the proxy (internal HTTP request) ----
function fetchProxiedHTML(proxyPath) {
    return new Promise((resolve, reject) => {
        const url = `${PROXY_ORIGIN}${proxyPath}`;
        http.get(url, (resp) => {
            // Follow redirects
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                const loc = resp.headers.location;
                resp.resume();
                return fetchProxiedHTML(loc.startsWith('/') ? loc : new URL(loc).pathname).then(resolve, reject);
            }
            let data = '';
            resp.on('data', c => data += c);
            resp.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ---- Navigate by fetching HTML and injecting DOM into the shell ----
async function navigateTo(realUrl) {
    currentUrl = realUrl;
    currentTitle = '';
    broadcastStatus();
    const proxyPath = toProxyUrl(realUrl);
    console.log(`[nav] ${realUrl} → ${proxyPath}`);

    try {
        const html = await fetchProxiedHTML(proxyPath);
        console.log(`[nav] Fetched ${html.length} chars`);

        // Send the HTML to the shell page for DOM injection
        const r = await cdpSend('Runtime.evaluate', {
            expression: `window.shellNavigate(${JSON.stringify(html)})`,
            returnByValue: true,
        });
        const info = r?.result?.value;
        if (info?.title) {
            currentTitle = info.title;
            broadcastStatus();
        }
        console.log(`[nav] Injected: ${info?.children} nodes, ${info?.height}px`);
    } catch (e) {
        console.error(`[nav] Error: ${e.message}`);
    }
}

// ---- Clients ----
const displayClients = new Set();
const controlClients = new Set();

function broadcastFrame(base64Data) {
    const buf = Buffer.from(base64Data, 'base64');
    for (const c of displayClients) {
        try { if (c.readyState === WebSocket.OPEN) c.send(buf); } catch (e) {}
    }
}

function broadcastStatus() {
    const msg = JSON.stringify({ type: 'status', url: currentUrl, title: currentTitle });
    for (const c of controlClients) {
        try { if (c.readyState === WebSocket.OPEN) c.send(msg); } catch (e) {}
    }
}

// ==================== HTTP SERVER ====================

const server = http.createServer((req, res) => {
    const url = req.url;

    // ---- Proxy requests: /p/<proto>/<host>/<path> ----
    const realUrl = fromProxyPath(url);
    if (realUrl) {
        return proxyRequest(realUrl, req, res);
    }

    // ---- API endpoints ----
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    if (req.method === 'POST' && url === '/navigate') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const { url: navUrl } = JSON.parse(body);
                if (!navUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url required' })); }
                await navigateTo(navUrl);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, url: navUrl }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && url === '/back') {
        cdpSend('Runtime.evaluate', { expression: 'history.back()' }).catch(() => {});
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'POST' && url === '/forward') {
        cdpSend('Runtime.evaluate', { expression: 'history.forward()' }).catch(() => {});
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'POST' && url === '/reload') {
        cdpSend('Page.reload').catch(() => {});
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'GET' && url === '/status') {
        res.writeHead(200);
        return res.end(JSON.stringify({ url: currentUrl, title: currentTitle }));
    }

    // ---- Serve shell page (must be same-origin as proxy for drawElementImage) ----
    if (req.method === 'GET' && url === '/shell.html') {
        try {
            const html = readFileSync('/app/shell.html', 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        } catch (e) {
            res.writeHead(500); return res.end('shell.html not found');
        }
    }

    // ---- Fallback: unmatched paths are probably relative links on the current site ----
    // Redirect /blog → /p/https/current-host.com/blog
    if (currentUrl && currentUrl !== 'about:blank' && url.startsWith('/') && !url.startsWith('/p/')) {
        try {
            const cu = new URL(currentUrl);
            const redirectTo = `/p/${cu.protocol.replace(':', '')}/${cu.host}${url}`;
            console.log(`[fallback] ${url} → ${redirectTo}`);
            res.writeHead(302, { Location: redirectTo });
            return res.end();
        } catch (e) {}
    }

    res.writeHead(404);
    res.end('Not found');
});

// ---- WebSockets ----
const displayWss = new WebSocketServer({ noServer: true });
const controlWss = new WebSocketServer({ noServer: true });

displayWss.on('connection', (ws) => {
    displayClients.add(ws);
    console.log(`[display] +1 (${displayClients.size})`);
    if (latestFrame) try { ws.send(Buffer.from(latestFrame, 'base64')); } catch (e) {}

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'scroll') {
                // Scroll the injected DOM via shell
                cdpSend('Runtime.evaluate', {
                    expression: `window.shellScroll(${msg.deltaY || 0})`,
                }).catch(() => {});
            } else if (msg.type === 'mouse' && msg.action === 'mousePressed') {
                // Find element at click coords — check for links
                cdpSend('Runtime.evaluate', {
                    expression: `(function() {
                        var el = document.elementFromPoint(${msg.x}, ${msg.y});
                        if (!el) return null;
                        var a = el.closest('a[href]');
                        if (a) return a.getAttribute('href');
                        return null;
                    })()`,
                    returnByValue: true,
                }).then(r => {
                    const href = r?.result?.value;
                    if (href && typeof href === 'string') {
                        // Resolve the link
                        let resolved = href;
                        try {
                            if (href.startsWith('/p/')) {
                                const real = fromProxyPath(href);
                                if (real) resolved = real;
                            } else if (href.startsWith('http://') || href.startsWith('https://')) {
                                resolved = href;
                            } else if (href.startsWith('/') && currentUrl) {
                                const cu = new URL(currentUrl);
                                resolved = cu.origin + href;
                            } else if (currentUrl) {
                                const cu = new URL(currentUrl);
                                resolved = cu.origin + '/' + href;
                            }
                        } catch(e) {}
                        if (resolved && resolved.startsWith('http')) {
                            console.log(`[click] ${href} → ${resolved}`);
                            navigateTo(resolved);
                        }
                    }
                }).catch(() => {});
            }
        } catch (e) {}
    });

    ws.on('close', () => displayClients.delete(ws));
});

controlWss.on('connection', (ws) => {
    controlClients.add(ws);
    ws.send(JSON.stringify({ type: 'status', url: currentUrl, title: currentTitle }));
    ws.on('close', () => controlClients.delete(ws));
});

server.on('upgrade', (req, socket, head) => {
    if (req.url === '/display-ws') displayWss.handleUpgrade(req, socket, head, ws => displayWss.emit('connection', ws, req));
    else if (req.url === '/control-ws') controlWss.handleUpgrade(req, socket, head, ws => controlWss.emit('connection', ws, req));
    else socket.destroy();
});

// ==================== MAIN ====================

async function main() {
    // Start HTTP server first (so proxy is available when shell loads iframe)
    await new Promise((resolve) => {
        server.listen(PORT, '127.0.0.1', () => {
            console.log(`[ctrl] Server on :${PORT}`);
            console.log(`[ctrl] Proxy: ${PROXY_ORIGIN}/p/<proto>/<host>/<path>`);
            resolve();
        });
    });

    console.log('[main] Waiting for Chrome...');
    for (let i = 0; i < 30; i++) {
        try { await connectCDP(); break; }
        catch (e) { if (i === 29) throw e; await new Promise(r => setTimeout(r, 1000)); }
    }

    await cdpSend('Page.enable');
    await cdpSend('Runtime.enable');

    // Load the shell page (same-origin as proxy, required for drawElementImage)
    console.log('[main] Loading shell page...');
    await cdpSend('Page.navigate', { url: `${PROXY_ORIGIN}/shell.html` });
    // Wait for shell to be ready
    for (let i = 0; i < 20; i++) {
        try {
            const r = await cdpSend('Runtime.evaluate', { expression: 'window.shellReady === true' });
            if (r?.result?.value === true) break;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    console.log('[main] Shell ready');

    // Start screencast
    await cdpSend('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
    });
    console.log('[screencast] Started');
}

main().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
