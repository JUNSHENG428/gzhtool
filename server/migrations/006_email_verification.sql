-- Run before deploying the email-ownership fix. Existing password accounts
-- must prove ownership through the password-reset email before auto-claiming.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

-- Only OAuth-only accounts have no pre-existing password that an impersonator
-- could keep using. Do not backfill previously auto-linked password accounts.
UPDATE users SET email_verified_at = COALESCE(last_login_at, created_at)
WHERE oauth_provider = 'google' AND password_salt = 'oauth:google';
