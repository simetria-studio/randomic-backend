const express = require('express');
const multer = require('multer');
const path = require('path');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { saveFile, deleteFile } = require('../storage');
const { loadProfile } = require('../profile');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENDERS = ['masculino', 'feminino', 'outro'];
const TYPES = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const p = await loadProfile(req.userId);
    if (!p) return res.status(401).json({ error: 'token_invalido' });
    res.json(p);
  } catch (e) {
    next(e);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const { nickname, gender, country } = req.body || {};
    const sets = [];
    const vals = [];
    if (nickname !== undefined) {
      if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 30) {
        return res.status(400).json({ error: 'apelido_invalido' });
      }
      vals.push(nickname.trim());
      sets.push(`nickname = $${vals.length}`);
    }
    if (gender !== undefined) {
      if (!GENDERS.includes(gender)) return res.status(400).json({ error: 'genero_invalido' });
      vals.push(gender);
      sets.push(`gender = $${vals.length}`);
    }
    if (country !== undefined) {
      if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) {
        return res.status(400).json({ error: 'pais_invalido' });
      }
      vals.push(country.toUpperCase());
      sets.push(`country = $${vals.length}`);
    }
    if (sets.length) {
      vals.push(req.userId);
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    const p = await loadProfile(req.userId);
    if (!p) return res.status(401).json({ error: 'token_invalido' });
    res.json(p);
  } catch (e) {
    next(e);
  }
});

function uploadPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'arquivo_grande' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'upload_invalido' });
    next(err);
  });
}

router.post('/photos', uploadPhoto, async (req, res, next) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'arquivo_ausente' });
    const ext = path.extname(f.originalname || '').slice(1).toLowerCase();
    if (!TYPES[f.mimetype] || !TYPES[f.mimetype].includes(ext)) {
      return res.status(400).json({ error: 'tipo_invalido' });
    }
    const url = await saveFile(f.buffer, ext === 'jpeg' ? 'jpg' : ext);
    const { rows } = await query(
      `INSERT INTO photos (user_id, url, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM photos WHERE user_id = $1), 0))
       RETURNING id, url`,
      [req.userId, url]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.delete('/photos/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'nao_encontrada' });
    const { rows } = await query('DELETE FROM photos WHERE id = $1 AND user_id = $2 RETURNING url', [
      req.params.id,
      req.userId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'nao_encontrada' });
    await deleteFile(rows[0].url);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.put('/fcm-token', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !token || token.length > 4096) {
      return res.status(400).json({ error: 'token_invalido' });
    }
    await query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id <> $2', [token, req.userId]);
    await query('UPDATE users SET fcm_token = $1 WHERE id = $2', [token, req.userId]);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.delete('/fcm-token', async (req, res, next) => {
  try {
    await query('UPDATE users SET fcm_token = NULL WHERE id = $1', [req.userId]);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
