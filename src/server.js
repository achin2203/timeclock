const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { HttpError } = require('./util');

const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');

function createApp() {
  const db = require('./db');
  const app = express();
  app.set('trust proxy', 1); // behind Lambda function URL / CloudFront

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': ["'self'", 'https://accounts.google.com/gsi/client', 'https://connect.facebook.net'],
          'frame-src': ["'self'", 'https://accounts.google.com', 'https://www.facebook.com', 'https://web.facebook.com'],
          'connect-src': ["'self'", 'https://accounts.google.com', 'https://graph.facebook.com', 'https://www.facebook.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
          'img-src': ["'self'", 'data:', 'https:'],
        },
      },
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for Google/Facebook popups
    })
  );
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  // CSRF guard: state-changing API calls must be JSON (cross-site forms can't send that without CORS).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
  });

  app.get('/healthz', async (req, res) => {
    try {
      await db.ping();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const { router: authRouter } = require('./auth');
  app.use('/api/auth', authRouter);
  app.use('/api', require('./routes/api'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(PUBLIC_DIR, { maxAge: 0, index: 'index.html' })); // always revalidate (ETag) so updates show up immediately
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const expected = err instanceof HttpError || Number.isInteger(err.status);
    const status = expected ? err.status : 500;
    if (!expected) console.error(err);
    res.status(status).json({ error: !expected && process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
  });
  return app;
}

// Local development: `npm run dev` starts an in-memory DynamoDB (dynalite) unless DYNAMODB_ENDPOINT
// or real AWS settings are provided.
async function startLocal() {
  if (!process.env.DYNAMODB_ENDPOINT && process.env.NODE_ENV !== 'production') {
    const dynalite = require('dynalite');
    const srv = dynalite({ createTableMs: 0 });
    await new Promise((r) => srv.listen(0, r));
    process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${srv.address().port}`;
    console.log('Using in-memory DynamoDB (data is lost on restart)');
  }
  await require('./db').ensureTable();
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, () => console.log(`TimeClock listening on http://localhost:${port}`));
}

if (require.main === module) {
  startLocal().catch((e) => {
    console.error('Startup failed', e);
    process.exit(1);
  });
}

module.exports = { createApp };
