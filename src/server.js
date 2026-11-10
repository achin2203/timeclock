const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { knex, migrate } = require('./db');
const { HttpError } = require('./util');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind AWS App Runner / ALB / CloudFront

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
      await knex.raw('select 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const { router: authRouter } = require('./auth');
  app.use('/api/auth', authRouter);
  app.use('/api', require('./routes/api'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const expected = err instanceof HttpError || Number.isInteger(err.status);
    const status = expected ? err.status : 500;
    if (!expected) console.error(err);
    res.status(status).json({ error: !expected && process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  migrate()
    .then(() => createApp().listen(port, () => console.log(`TimeClock listening on :${port}`)))
    .catch((e) => {
      console.error('Startup failed', e);
      process.exit(1);
    });
}

module.exports = { createApp };
