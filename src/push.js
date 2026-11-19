const { query } = require('./db');

let defaultMessaging;
let warned = false;

function getMessaging() {
  if (defaultMessaging !== undefined) return defaultMessaging;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!path) {
    if (!warned) console.warn('[push] FIREBASE_SERVICE_ACCOUNT not set; push notifications disabled');
    warned = true;
    defaultMessaging = null;
    return null;
  }
  const admin = require('firebase-admin');
  const app = admin.initializeApp({ credential: admin.credential.cert(require(require('path').resolve(path))) });
  defaultMessaging = admin.messaging(app);
  return defaultMessaging;
}

async function sendPush(userId, payload, { messaging } = {}) {
  try {
    const { rows } = await query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
    const token = rows[0] && rows[0].fcm_token;
    if (!token) return;
    const client = messaging || getMessaging();
    if (!client) return;
    try {
      await client.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: { conversationId: String(payload.conversationId) },
      });
    } catch (e) {
      if (e && e.code === 'messaging/registration-token-not-registered') {
        await query('UPDATE users SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2', [userId, token]);
      } else {
        console.error('[push] send failed', e && e.message);
      }
    }
  } catch (e) {
    console.error('[push] error', e && e.message);
  }
}

module.exports = { sendPush };
