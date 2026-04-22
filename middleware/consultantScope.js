/**
 * Consultants may only use service-request flows and document downloads for files on those requests.
 * Dashboard and all other admin sections return 403 (GET / redirects to service requests).
 */
const { forbidden403 } = require('../lib/adminRbac');

function restrictConsultantScope(req, res, next) {
  if (!res.locals.isConsultant) return next();
  const p = req.path || '';
  if (req.method === 'GET' && (p === '/' || p === '')) {
    return res.redirect('/admin/service-requests');
  }
  if (p.startsWith('/service-requests') || p.startsWith('/documents/download/')) {
    return next();
  }
  return forbidden403(
    req,
    res,
    'Not available',
    'Consultants can only access service requests assigned to their account.'
  );
}

module.exports = { restrictConsultantScope };
