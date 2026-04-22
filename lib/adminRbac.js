/**
 * Admin RBAC: super_admin (full), manager (no archive/delete), viewer (read-only),
 * consultant (assigned service requests only).
 */
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  MANAGER: 'manager',
  VIEWER: 'viewer',
  CONSULTANT: 'consultant',
};

function normalizeRole(role) {
  const r = String(role || '').trim();
  if (r === ROLES.MANAGER || r === ROLES.VIEWER || r === ROLES.CONSULTANT) return r;
  return ROLES.SUPER_ADMIN;
}

function rbacLocals(admin) {
  const role = normalizeRole(admin && admin.role);
  return {
    adminRole: role,
    isSuperAdmin: role === ROLES.SUPER_ADMIN,
    isManager: role === ROLES.MANAGER,
    isViewer: role === ROLES.VIEWER,
    isConsultant: role === ROLES.CONSULTANT,
    canMutate: role !== ROLES.VIEWER,
    canArchive: role === ROLES.SUPER_ADMIN,
  };
}

function forbidden403(req, res, title, message) {
  return res.status(403).render('admin/forbidden', {
    layout: 'layouts/admin',
    title: title || 'Access denied',
    message: message || 'You do not have permission to perform this action.',
    adminPath: req.path || '',
  });
}

/** Block non-GET or block viewers from mutating (use after adminLayoutLocals). */
function blockViewerMutations(req, res, next) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (!res.locals.canMutate) {
    return forbidden403(req, res, 'View only', 'Your account cannot change data.');
  }
  next();
}

/** Super admin only (archive, admin users, destructive deletes). */
function requireSuperAdmin(req, res, next) {
  if (!res.locals.isSuperAdmin) {
    return forbidden403(req, res, 'Super admin only', 'This action requires a super admin.');
  }
  next();
}

/**
 * Viewers may not open create/edit screens (GET).
 */
function enforceViewerReadOnlyGet(req, res, next) {
  if (!res.locals.isViewer) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path || '';
  if (p.includes('/new') || p.includes('/edit')) {
    return forbidden403(
      req,
      res,
      'View only',
      'Your role cannot open create or edit screens. Ask a super admin or manager for access.'
    );
  }
  next();
}

module.exports = {
  ROLES,
  normalizeRole,
  rbacLocals,
  forbidden403,
  blockViewerMutations,
  requireSuperAdmin,
  enforceViewerReadOnlyGet,
};
