# trippy-browse

A psychedelic web browser running in a [Vers](https://vers.sh) VM. Pages are rendered through Chrome's experimental `drawElementImage` html-in-canvas API with animated visual effects composited server-side and streamed as JPEG frames to your browser.

All web content flows through a reverse proxy so Chrome sees everything as same-origin, enabling html-in-canvas pixel access. Pages are fetched as HTML, parsed with `DOMParser`, and injected as direct children of a `<canvas layoutsubtree>` element. The canvas `onpaint` callback draws the DOM with a breathing scale animation, horizontal glitch strips, and lava lamp blobs — all baked into the screencast frames via CDP.

## Demo

Works best with content-heavy sites (lobste.rs, Hacker News, blog posts, docs). JS-heavy SPAs will break since DOM injection loses the page's JavaScript execution context.

## Architecture

```
┌─ Your Browser ───────────────────────────────────────────┐
│  ┌─ URL Bar ──────────────────────────────────────────┐  │
│  │  ← → ↻  [https://lobste.rs                      ] │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌─ <img> (JPEG stream from VM) ──────────────────────┐  │
│  │                                                    │  │
│  │  Rendered page + lava lamp blobs + glitch effect   │  │
│  │  All effects baked server-side via html-in-canvas  │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         │ WebSocket (binary JPEG frames + JSON input)
         ▼
┌─ Vers VM (4 vCPU, 4GB RAM) ─────────────────────────────┐
│  nginx (:80)                                             │
│    ├── /          → index.html (client UI)               │
│    └── /api/*     → Node.js control server (:3000)       │
│                                                          │
│  Control server (:3000)                                  │
│    ├── /p/<proto>/<host>/<path>  Reverse proxy           │
│    ├── /shell.html              Canvas compositor page   │
│    ├── POST /navigate           Fetch + inject page DOM  │
│    ├── WS /display-ws           JPEG stream + input      │
│    └── WS /control-ws           URL/title updates        │
│                                                          │
│  Chrome 147 (--enable-features=CanvasDrawElement)        │
│    └── Renders shell.html with <canvas layoutsubtree>    │
│        ├── drawElementImage() → rasterize injected DOM   │
│        ├── Canvas 2D fills    → lava lamp blobs          │
│        ├── drawImage(canvas)  → horizontal glitch strips │
│        └── Page.screencast    → JPEG stream to clients   │
│                                                          │
│  Xvfb :99 (1280x900x24) — virtual display for Chrome    │
└──────────────────────────────────────────────────────────┘
```

## How It Works

### Navigation Flow
1. User enters URL → `POST /api/navigate`
2. Control server fetches page HTML through internal reverse proxy
3. Proxy rewrites all URLs (href, src, srcset, url()) to `/p/<proto>/<host>/...` format
4. HTML sent to Chrome's shell page via CDP `Runtime.evaluate` → `window.shellNavigate(html)`
5. Shell page parses HTML with `DOMParser`, injects styles + body into `<canvas layoutsubtree>` child div
6. Canvas `onpaint` callback fires continuously:
   - `drawElementImage(viewport)` — rasterizes the injected DOM (~30ms on SwiftShader)
   - Horizontal strip copy-shift for glitch effect (free — pixel copy only)
   - Radial gradient fills for lava lamp blobs (free — canvas 2D ops)
7. CDP `Page.startScreencast` captures frames as JPEG
8. JPEG frames sent to clients over WebSocket

### Virtual Scrolling (Viewport Culling)
Large pages (e.g. 17K pixels tall) are too expensive for `drawElementImage` to rasterize every frame. The shell page implements virtual scrolling:
- After DOM injection, all block elements are measured and cataloged
- On scroll, elements outside the viewport (plus 1-viewport margin) get `visibility: hidden` + `content-visibility: hidden`
- This reduces rasterization cost from seconds per frame to milliseconds

### Adaptive Quality
Frame time is tracked with an exponential moving average. When FPS drops below 15, the glitch effect is automatically disabled to reclaim performance.

## Visual Effects

All effects are composited server-side in the canvas `onpaint` callback — zero cost to the client.

| Effect | Method | Cost |
|--------|--------|------|
| Page render | `drawElementImage(viewport)` | ~30ms (SwiftShader) |
| Breathing | ±2% scale pulse via `ctx.scale()` | Free (transform) |
| Glitch strips | `ctx.drawImage(canvas, ...)` copy-shift | Free (pixel copy) |
| Lava lamp blobs | `createRadialGradient` + `multiply` blend | Free (canvas 2D) |

9 blobs orbit lazily across the screen with warm (amber/coral/rose/gold) and accent (violet/teal) hues. The glitch shifts every-other 60px horizontal band with a slow wave + fast jitter.

## Quick Start

```bash
# One-time: build golden image with Chrome, Xvfb, Node.js, nginx
./create-golden-image.sh

# Launch a VM from the golden image
./launch.sh

# → Opens at https://<vm-id>.vm.vers.sh
```

## Requirements

- [Vers CLI](https://vers.sh) (`vers` command)
- Chrome 147+ stable (installed automatically in VM via `create-golden-image.sh`)
- The VM runs CPU-only (4 vCPU, 4GB RAM) — no GPU needed

## Key Constraints

- **`drawElementImage` only works on immediate canvas children** — can't target nested elements
- **HTTP-loaded iframes are invisible** to `drawElementImage` (Chrome Site Isolation) — that's why DOM injection is used instead
- **DOM injection breaks page JavaScript** — scripts run in the shell page's context. Static/content sites work great; SPAs don't.
- **~30ms per `drawElementImage` call** on SwiftShader — budget is 1 draw per frame for ~30fps
- **PyTorch must NOT be installed** in the VM — causes Chrome segfaults

## Files

| File | Description |
|------|-------------|
| `control-server.js` | Node.js server: reverse proxy, CDP bridge, JPEG streaming, input forwarding |
| `shell.html` | Canvas compositor: `<canvas layoutsubtree>`, DOM injection, visual effects, virtual scrolling |
| `index.html` | Client UI: URL bar, navigation buttons, JPEG display, input capture |
| `nginx.conf` | Port 80 reverse proxy to control server |
| `start.sh` | Launches Xvfb + Chrome + nginx + control server |
| `create-golden-image.sh` | Builds golden VM image with all dependencies |
| `launch.sh` | Spawns VM from golden commit and starts services |
| `vers.toml` | Vers VM configuration (4 vCPU, 4GB RAM, 8GB disk) |
