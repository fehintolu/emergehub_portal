/**
 * Active nav + subtitle for admin shell (paths are relative to /admin mount).
 */
function adminLayoutLocals(req, res, next) {
  res.locals.adminPath = req.path || '';
  next();
}

module.exports = { adminLayoutLocals };
