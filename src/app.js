const fs = require('fs');
const path = require('path');
const express = require('express');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const safetyRoutes = require('./routes/safety');
const conversationRoutes = require('./routes/conversations');
const adminRoutes = require('./routes/admin');
const { uploadDir } = require('./storage');

// CORS only for /admin-api and only when ADMIN_ORIGIN is set (read per request).
function adminCors(req, res, next) {
  const origin = process.env.ADMIN_ORIGIN;
  if (!origin) return next();
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function mountAdminStatic(app) {
  const dist = process.env.ADMIN_DIST || path.join(__dirname, '..', '..', 'admin', 'dist');
  if (!fs.existsSync(dist)) return;
  app.use('/admin', express.static(dist, { redirect: false }));
  app.get(['/admin', '/admin/{*splat}'], (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Public privacy policy page. Contact e-mail defaults to contato@dinblu.com.br; PRIVACY_CONTACT overrides it.
function privacyPage(req, res) {
  const file = path.join(__dirname, '..', 'public', 'privacidade.html');
  const contact = process.env.PRIVACY_CONTACT || 'contato@dinblu.com.br';
  const html = fs.readFileSync(file, 'utf8').replaceAll('{{CONTACT}}', contact);
  res.type('html').send(html);
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get(['/privacidade', '/privacy'], privacyPage);
  app.use('/auth', authRoutes);
  app.use('/uploads', express.static(uploadDir()));
  app.use('/admin-api', adminCors, adminRoutes);
  mountAdminStatic(app);
  app.use('/me', profileRoutes);
  app.use(safetyRoutes);
  app.use(conversationRoutes);
  return app;
}

module.exports = { createApp };
