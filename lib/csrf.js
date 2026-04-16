const crypto = require('crypto');

function ensureCsrfSecret(req) {
  if (!req.session._csrfSecret) {
    req.session._csrfSecret = crypto.randomBytes(32).toString('hex');
  }
  return req.session._csrfSecret;
}

function tokenForSession(req) {
  const secret = ensureCsrfSecret(req);
  return crypto.createHmac('sha256', secret).update('csrf').digest('hex');
}

function csrfMiddleware(req, res, next) {
  res.locals.csrfToken = tokenForSession(req);
  next();
}

function requireValidCsrf(req, res, next) {
  const body = req.body && req.body._csrf;
  const expected = tokenForSession(req);
  if (!body || body !== expected) {
    return res.status(403).send('Invalid security token. Go back and try again.');
  }
  next();
}

module.exports = { csrfMiddleware, requireValidCsrf, tokenForSession };
