/**
 * Active nav + subtitle for admin shell (paths are relative to /admin mount).
 */
const { rbacLocals } = require('../lib/adminRbac');

function adminLayoutLocals(req, res, next) {
  res.locals.adminPath = req.path || '';
  const rbac = rbacLocals(res.locals.currentAdmin);
  Object.assign(res.locals, rbac);
  /* Defensive: never leave RBAC flags undefined (templates use typeof checks that hide UI). */
  if (typeof res.locals.canMutate !== 'boolean') res.locals.canMutate = rbac.canMutate;
  if (typeof res.locals.isSuperAdmin !== 'boolean') res.locals.isSuperAdmin = rbac.isSuperAdmin;
  if (typeof res.locals.canArchive !== 'boolean') res.locals.canArchive = rbac.canArchive;
  if (typeof res.locals.isViewer !== 'boolean') res.locals.isViewer = rbac.isViewer;
  if (typeof res.locals.isConsultant !== 'boolean') res.locals.isConsultant = rbac.isConsultant;
  next();
}

module.exports = { adminLayoutLocals };
