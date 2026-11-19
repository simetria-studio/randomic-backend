const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../auth');
const { saveFile } = require('../storage');
const conv = require('../conversations');
const { isInteractionBlocked } = require('./safety');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };
const AUDIO_TYPES = {
  'audio/mp4': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/m4a': ['m4a'],
  'audio/aac': ['aac'],
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/ogg': ['ogg'],
  'application/ogg': ['ogg'],
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * MB, files: 1 } });

function sendError(res, e, next) {
  if (e.message === 'forbidden' || e.message === 'bloqueado') return res.status(403).json({ error: e.message });
  if (e.message === 'cursor_invalido') return res.status(400).json({ error: e.message });
  return next(e);
}

router.use(requireAuth);

router.get('/conversations', async (req, res, next) => {
  try {
    res.json(await conv.listConversations(req.userId));
  } catch (e) {
    next(e);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'nao_encontrada' });
    res.json(await conv.listMessages(req.params.id, req.userId, req.query.before, req.query.limit));
  } catch (e) {
    sendError(res, e, next);
  }
});

router.delete('/conversations/:id', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'nao_encontrada' });
    await conv.hideConversation(req.params.id, req.userId);
    res.status(204).end();
  } catch (e) {
    sendError(res, e, next);
  }
});

function uploadFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'arquivo_grande' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'upload_invalido' });
    next(err);
  });
}

async function checkParticipant(req, res, next) {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'nao_encontrada' });
    const c = await conv.getConversation(req.params.id);
    if (!c || (c.user_a !== req.userId && c.user_b !== req.userId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const other = c.user_a === req.userId ? c.user_b : c.user_a;
    if (await isInteractionBlocked(req.userId, other)) return res.status(403).json({ error: 'bloqueado' });
    next();
  } catch (e) {
    next(e);
  }
}

router.post('/conversations/:id/media', checkParticipant, uploadFile, async (req, res, next) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'arquivo_ausente' });
    const ext = path.extname(f.originalname || '').slice(1).toLowerCase();
    let kind = null;
    if (PHOTO_TYPES[f.mimetype] && PHOTO_TYPES[f.mimetype].includes(ext)) kind = 'photo';
    else if (AUDIO_TYPES[f.mimetype] && AUDIO_TYPES[f.mimetype].includes(ext)) kind = 'audio';
    if (!kind) return res.status(400).json({ error: 'tipo_invalido' });
    if (kind === 'photo' && f.size > 5 * MB) return res.status(413).json({ error: 'arquivo_grande' });
    const url = await saveFile(f.buffer, ext === 'jpeg' ? 'jpg' : ext);
    res.status(201).json({ url });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
