const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const elevatedUsers = new Set();

const authenticate = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  try {
    const verified = jwt.verify(token.split(' ')[1], SECRET);
    if (verified.isTemporary && !elevatedUsers.has(verified.username)) {
      return res.status(401).json({ error: 'Temporary access revoked' });
    }
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

const optionalAuthenticate = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const verified = jwt.verify(token.split(' ')[1], SECRET);
    req.user = (verified.isTemporary && !elevatedUsers.has(verified.username)) ? null : verified;
  } catch (err) {
    req.user = null;
  }
  next();
};

/**
 * The canonical world is editable by the primary administrator and nobody else.
 *
 * `authenticate` alone is not that boundary: it admits players, and it admits a temporary
 * admin the moment someone elevates them. Elevation is a session convenience — it lets a
 * guest run part of a game — and it must not become permission to move the Imperial City.
 *
 * Mounted as `authenticate, requireWorldEditor`, so a missing or invalid token is already
 * answered by 401 before this runs and everything reaching here is an authenticated user
 * who is simply not allowed. Deliberately a small explicit check rather than the first
 * step of a role system: the only distinction this slice needs is primary admin or not.
 */
const requireWorldEditor = (req, res, next) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Access denied' });
  if (user.role !== 'admin' || user.isTemporary !== false) {
    return res.status(403).json({ error: 'Only the primary administrator can edit the canonical world' });
  }
  next();
};

module.exports = { authenticate, optionalAuthenticate, requireWorldEditor, elevatedUsers };
