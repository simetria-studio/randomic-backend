const { Server } = require('socket.io');
const { authenticateToken } = require('./auth');
const { Matchmaker } = require('./matchmaking');
const { loadProfile } = require('./profile');
const { sendPush: defaultSendPush } = require('./push');
const { query } = require('./db');
const conversations = require('./conversations');
const hub = require('./hub');

const room = (userId) => `user:${userId}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_ERRORS = ['forbidden', 'bloqueado', 'mensagem_invalida', 'usuarios_invalidos', 'filtro_invalido'];

function partnerPayload(p) {
  return { id: p.id, nickname: p.nickname, age: p.age, gender: p.gender, photos: p.photos };
}

function parseFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const { minAge, maxAge } = f;
  const genders = f.genders === undefined ? [] : f.genders;
  const country = f.country === undefined ? 'BR' : f.country;
  if (!Number.isFinite(minAge) || !Number.isFinite(maxAge)) return null;
  if (minAge > maxAge || !Array.isArray(genders) || typeof country !== 'string') return null;
  return { minAge, maxAge, genders, country };
}

function previewOf(message) {
  if (message.type === 'text') return message.body;
  return message.type === 'photo' ? '📷 Foto' : '🎤 Áudio';
}

function attachRealtime(httpServer, { pushSender = defaultSendPush, now } = {}) {
  const io = new Server(httpServer, { cors: { origin: '*' } });
  // userId -> pending partnerId. Entries are per-user: a skip/disconnect removes only that
  // user's own entry, so the partner can still choose "talk" (spec: one "Conversar" is enough).
  const pairs = new Map();

  const isOnline = (userId) => (io.sockets.adapter.rooms.get(room(userId))?.size || 0) > 0;
  const emitTo = (userId, event, data) => io.to(room(userId)).emit(event, data);
  const clearPair = (a, b) => {
    if (pairs.get(a) === b) pairs.delete(a);
    if (pairs.get(b) === a) pairs.delete(b);
  };

  async function announceMatch(aId, bId) {
    pairs.set(aId, bId);
    pairs.set(bId, aId);
    const [a, b] = await Promise.all([loadProfile(aId), loadProfile(bId)]);
    if (!a || !b) return;
    emitTo(aId, 'search:found', { partner: partnerPayload(b) });
    emitTo(bId, 'search:found', { partner: partnerPayload(a) });
  }

  const matchmaker = new Matchmaker({
    ...(now ? { now } : {}),
    onMatch(aId, bId) {
      try {
        announceMatch(aId, bId).catch((e) => console.error('[realtime] onMatch', e));
      } catch (e) {
        console.error('[realtime] onMatch', e);
      }
    },
    onTimeout(userId) {
      try {
        emitTo(userId, 'search:none');
      } catch (e) {
        console.error('[realtime] onTimeout', e);
      }
    },
  });

  io.use(async (socket, next) => {
    try {
      socket.userId = await authenticateToken(socket.handshake.auth && socket.handshake.auth.token);
      next();
    } catch (e) {
      if (e.code === 'conta_suspensa' || e.code === 'conta_banida') {
        return next(Object.assign(new Error(e.code), { data: e.data }));
      }
      if (!e.code) console.error('[realtime] handshake auth failed', e);
      // keep the message the existing app expects for every other auth failure
      next(new Error('nao_autenticado'));
    }
  });

  const handlers = {
    async 'search:start'(socket, data) {
      const filter = parseFilter(data);
      if (!filter) return socket.emit('error', { code: 'filtro_invalido', event: 'search:start' });
      pairs.delete(socket.userId);
      const p = await loadProfile(socket.userId);
      if (!p || p.photos.length === 0) return socket.emit('error', { code: 'perfil_incompleto', event: 'search:start' });
      await matchmaker.enqueue(socket.userId, { age: p.age, gender: p.gender, country: p.country }, filter);
    },

    async 'search:cancel'(socket) {
      matchmaker.dequeue(socket.userId);
    },

    async 'match:choose'(socket, data) {
      const { partnerId, action } = data || {};
      const me = socket.userId;
      if (!partnerId || pairs.get(me) !== partnerId || !['talk', 'skip'].includes(action)) {
        return socket.emit('error', { code: 'parceiro_invalido', event: 'match:choose' });
      }
      if (action === 'skip') {
        pairs.delete(me);
        await matchmaker.recordSkip(me, partnerId);
        return;
      }
      const { id } = await conversations.getOrCreateConversation(me, partnerId);
      clearPair(me, partnerId);
      emitTo(me, 'match:conversation', { conversationId: id });
      if (isOnline(partnerId)) emitTo(partnerId, 'match:conversation', { conversationId: id });
    },

    async 'message:send'(socket, data) {
      const { conversationId, type, body, mediaUrl } = data || {};
      const me = socket.userId;
      if (!UUID_RE.test(String(conversationId))) throw new Error('forbidden');
      const message = await conversations.sendMessage(conversationId, me, { type, body, mediaUrl });
      const conv = await conversations.getConversation(conversationId);
      const recipient = conv.user_a === me ? conv.user_b : conv.user_a;
      emitTo(me, 'message:new', { message });
      emitTo(recipient, 'message:new', { message });
      if (isOnline(recipient)) {
        await conversations.markDelivered(message.id);
        emitTo(me, 'message:status', { messageId: message.id, status: 'delivered' });
      } else {
        const { rows } = await query('SELECT nickname FROM users WHERE id = $1', [me]);
        await pushSender(recipient, { title: rows[0].nickname, body: previewOf(message), conversationId });
      }
    },

    async 'message:read'(socket, data) {
      const { conversationId } = data || {};
      const me = socket.userId;
      if (!UUID_RE.test(String(conversationId))) throw new Error('forbidden');
      const ids = await conversations.markRead(conversationId, me);
      if (ids.length === 0) return;
      const conv = await conversations.getConversation(conversationId);
      const sender = conv.user_a === me ? conv.user_b : conv.user_a;
      for (const messageId of ids) emitTo(sender, 'message:status', { messageId, status: 'read' });
    },
  };

  io.on('connection', (socket) => {
    socket.join(room(socket.userId));
    conversations
      .markAllDeliveredFor(socket.userId)
      .then((delivered) => {
        for (const { id, senderId } of delivered) {
          emitTo(senderId, 'message:status', { messageId: id, status: 'delivered' });
        }
      })
      .catch((e) => console.error('[realtime] deliver on connect', e));
    for (const [event, fn] of Object.entries(handlers)) {
      socket.on(event, async (data) => {
        try {
          await fn(socket, data);
        } catch (e) {
          const code = e && e.message;
          if (!KNOWN_ERRORS.includes(code)) console.error('[realtime]', event, e);
          // `event` lets clients route errors (search screen vs chat).
          socket.emit('error', { code: KNOWN_ERRORS.includes(code) ? code : 'erro_interno', event });
        }
      });
    }
    socket.on('disconnect', () => {
      if (!isOnline(socket.userId)) {
        matchmaker.dequeue(socket.userId);
        pairs.delete(socket.userId);
      }
    });
  });

  hub.setOnlineCounter(() => {
    let n = 0;
    for (const [name, sockets] of io.sockets.adapter.rooms) {
      if (name.startsWith('user:') && sockets.size > 0) n++;
    }
    return n;
  });
  const unsubscribe = hub.onRestricted((userId) => {
    matchmaker.dequeue(userId);
    pairs.delete(userId);
    io.in(room(userId)).disconnectSockets(true);
  });
  const origClose = io.close.bind(io);
  io.close = (...args) => {
    unsubscribe();
    return origClose(...args);
  };

  return { io, matchmaker };
}

module.exports = { attachRealtime };
