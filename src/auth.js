const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { effectiveStatus, restrictionBody } = require('./accountStatus');

function getSecret() {
  const secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'test' ? 'test-secret' : null);
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

function signToken(userId, tokenVersion = 0) {
  return jwt.sign({ sub: userId, tv: tokenVersion }, getSecret(), { expiresIn: '30d' });
}

function authError(code, data) {
  return Object.assign(new Error(code), { code, data: data || { error: code } });
}

// Verifies the JWT and the account state in the database. Returns { userId, role }.
async function checkToken(token) {
  if (!token) throw authError('nao_autenticado');
  let payload;
  try {
    payload = jwt.verify(token, getSecret());
  } catch {
    throw authError('token_invalido');
  }
  const { rows } = await query(
    'SELECT id, role, status, suspended_until, status_reason, token_version FROM users WHERE id = $1',
    [payload.sub]
  );
  const row = rows[0];
  if (!row) throw authError('token_invalido');
  if (effectiveStatus(row) !== 'active') {
    const body = restrictionBody(row);
    throw authError(body.error, body);
  }
  // tokens issued before versioning have no tv: treated as version 0
  if ((payload.tv ?? 0) !== row.token_version) throw authError('token_invalido');
  return { userId: row.id, role: row.role };
}

async function authenticateToken(token) {
  return (await checkToken(token)).userId;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'nao_autenticado' });
    const { userId, role } = await checkToken(token);
    req.userId = userId;
    req.userRole = role;
    next();
  } catch (e) {
    if (e.code && e.data) {
      const restricted = e.code === 'conta_suspensa' || e.code === 'conta_banida';
      return res.status(restricted ? 403 : 401).json(e.data);
    }
    next(e);
  }
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

// birthdate 'YYYY-MM-DD'; today compared by UTC calendar date
function isAdult(birthdate, today = new Date()) {
  const [y, m, d] = birthdate.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  const tm = today.getUTCMonth() + 1;
  if (tm < m || (tm === m && today.getUTCDate() < d)) age--;
  return age >= 18;
}

module.exports = { signToken, requireAuth, requireAdmin, authenticateToken, isAdult };
