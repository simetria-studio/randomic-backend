ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 0;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned'));
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_removed_at timestamptz;

CREATE TABLE IF NOT EXISTS admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('suspend','ban','reactivate','remove_media','dismiss_report')),
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  report_id uuid REFERENCES reports(id) ON DELETE SET NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions (target_user_id, created_at);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at);
