// A tiny status endpoint so the Windows companion knows when to roll video,
// plus a public /health readiness probe for the host platform (Railway etc).
//
// The bot can see that somebody has started a screen share - Discord exposes
// that as a flag on their voice state - it just can't see the pixels. Those
// only exist on the machine doing the sharing. So the bot says "a share just
// started", and the companion on that machine does the actual recording.

import http from 'node:http';

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.secret]      gates /status only - see below
 * @param {() => object} opts.getState
 * @param {() => boolean} [opts.isReady]  true once at least one bot slot is
 *   logged in and its gateway connection is ready - drives /health. Absent
 *   or throwing counts as "not ready" rather than crashing the server.
 * @param {object} opts.log
 */
export function startStatusServer({ port, secret, getState, isReady, log }) {
  // /health has to work with no companion set up at all - a platform health
  // check shouldn't depend on a variable that only exists for the Windows
  // video companion. /status still needs the secret; without one, safeEqual()
  // below can never match any key, so it stays locked shut on its own -
  // no special-casing needed for that route.
  if (!secret) {
    log.info('COMPANION_SECRET not set - /status (video companion) stays locked, but /health still starts');
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      let ready = false;
      try {
        ready = Boolean(isReady?.());
      } catch (err) {
        log.warn(`/health readiness check threw: ${err.message}`);
      }
      if (ready) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ready: true }));
      }
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ ok: false, reason: 'no bot slot is logged in and ready' })
      );
    }

    if (url.pathname !== '/status') {
      res.writeHead(404);
      return res.end();
    }

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key') ?? '';
    if (!safeEqual(token, secret)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad or missing key' }));
    }

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(getState()));
  });

  server.listen(port, () => log.info(`status endpoint listening on :${port}`));
  server.on('error', (err) => log.warn(`status server error: ${err.message}`));
  return server;
}

/** Constant-time-ish comparison, so the key can't be guessed a character at a time. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
