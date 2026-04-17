require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./lib/db');
const { csrfMiddleware } = require('./lib/csrf');
const { loadMember } = require('./middleware/memberAuth');
const { loadAdmin } = require('./middleware/adminAuth');
const paystackWebhook = require('./routes/paystackWebhook');
const authRoutes = require('./routes/auth');
const memberArea = require('./routes/memberArea');
const memberMeetingRooms = require('./routes/memberMeetingRooms');
const adminLogin = require('./routes/adminLogin');
const adminMain = require('./routes/adminMain');
const adminMeetingRooms = require('./routes/adminMeetingRooms');

const app = express();
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

function assetMtimeMs(relativePath) {
  try {
    return fs.statSync(path.join(__dirname, relativePath)).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Bust browser/CDN caches when CSS changes (query string + weak validators). */
app.locals.memberPortalCssV = String(
  process.env.PORTAL_ASSET_VERSION || assetMtimeMs('public/css/member-portal.css')
);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(morgan('combined'));

app.use('/api/webhooks', paystackWebhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  })
);

const memberSessionSecret =
  process.env.MEMBER_SESSION_SECRET || process.env.SESSION_SECRET || 'dev-member';
const adminSessionSecret =
  process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET + '-admin';

const memberSessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'member_sessions',
    createTableIfMissing: false,
  }),
  name: 'portal.member.sid',
  secret: memberSessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === '1',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

const adminSessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'portal_admin_sessions',
    createTableIfMissing: false,
  }),
  name: 'portal.admin.sid',
  secret: adminSessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === '1',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 4 * 60 * 60 * 1000,
  },
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/admin')) {
    return adminSessionMiddleware(req, res, next);
  }
  return memberSessionMiddleware(req, res, next);
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/admin')) {
    return loadAdmin(req, res, next);
  }
  return loadMember(req, res, next);
});

app.use(csrfMiddleware);

app.get('/health', (req, res) => {
  res.json({ ok: true, app: 'emergehub-portal' });
});

app.get('/', (req, res) => {
  if (req.session.memberId) return res.redirect('/dashboard');
  res.redirect('/auth/login');
});

app.use('/auth', authRoutes);

/* Admin must be registered before memberArea: memberArea uses requireMember on all
   its routes; mounting it first would run that middleware for /admin/* and redirect
   guests to /auth/login. */
app.use('/admin', adminLogin);
app.use('/admin', adminMeetingRooms);
app.use('/admin', adminMain);

app.use(memberMeetingRooms);
app.use(memberArea);

app.use((req, res) => {
  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Server error');
});

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4601;
app.listen(PORT, HOST, () => {
  console.log(`EmergeHub portal listening on http://${HOST}:${PORT}`);
  try {
    const { startPortalCron } = require('./lib/portalJobs');
    startPortalCron();
  } catch (e) {
    console.error('portal cron init', e);
  }
});
