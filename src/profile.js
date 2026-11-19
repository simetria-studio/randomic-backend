const { query } = require('./db');

function ageOf(birthdate, today = new Date()) {
  const s = birthdate instanceof Date ? birthdate.toISOString().slice(0, 10) : birthdate;
  const [y, m, d] = s.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  const tm = today.getUTCMonth() + 1;
  if (tm < m || (tm === m && today.getUTCDate() < d)) age--;
  return age;
}

async function loadProfile(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const u = rows[0];
  if (!u) return null;
  const photos = (await query('SELECT id, url FROM photos WHERE user_id = $1 ORDER BY position, id', [userId])).rows;
  return {
    id: u.id,
    nickname: u.nickname,
    age: ageOf(u.birthdate),
    gender: u.gender,
    country: u.country,
    photos,
    profileComplete: photos.length >= 1,
  };
}

module.exports = { ageOf, loadProfile };
