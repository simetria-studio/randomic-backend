// Effective account status; an expired suspension counts as active (no job needed).
function effectiveStatus(row, now = new Date()) {
  if (row.status === 'banned') return 'banned';
  if (row.status === 'suspended') {
    const until = row.suspended_until;
    if (!until || new Date(until).getTime() > now.getTime()) return 'suspended';
  }
  return 'active';
}

function restrictionBody(row, now = new Date()) {
  const st = effectiveStatus(row, now);
  const suspended = st === 'suspended';
  return {
    error: suspended ? 'conta_suspensa' : 'conta_banida',
    until: suspended && row.suspended_until ? new Date(row.suspended_until).toISOString() : null,
    reason: row.status_reason ?? null,
  };
}

module.exports = { effectiveStatus, restrictionBody };
