-- 002: user registration approval + admin user management.
--
-- Adds an approval workflow to the public `users` table and an audit trail
-- for administrative account decisions. Administrators live in the separate
-- `admins` table and are NOT touched by this migration.
--
-- SAFE DATA POLICY (existing production rows are preserved, never deleted):
--   * every EXISTING account with is_active = 1 is grandfathered to
--     status = 'approved' — no existing customer is locked out;
--   * every EXISTING account with is_active = 0 becomes 'suspended';
--   * every NEW registration defaults to 'pending' and needs an admin
--     approval before it can reach any protected feature.
--
-- Safe on MySQL 5.7+ and MariaDB 10.3+ (cPanel target). Runs exactly once;
-- recorded with a checksum in `schema_migrations`.

ALTER TABLE `users`
  ADD COLUMN `full_name`            VARCHAR(120) NOT NULL DEFAULT '' AFTER `username`,
  ADD COLUMN `status`               ENUM('pending','approved','rejected','suspended') NOT NULL DEFAULT 'pending' AFTER `is_active`,
  ADD COLUMN `approved_at`          DATETIME     NULL AFTER `status`,
  ADD COLUMN `approved_by_admin_id` INT UNSIGNED NULL AFTER `approved_at`,
  ADD COLUMN `status_reason`        VARCHAR(255) NULL COMMENT 'optional admin reason for rejection / suspension' AFTER `approved_by_admin_id`,
  ADD COLUMN `status_changed_at`    DATETIME     NULL AFTER `status_reason`,
  ADD KEY `idx_users_status` (`status`),
  ADD CONSTRAINT `fk_users_approved_by` FOREIGN KEY (`approved_by_admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Grandfather existing accounts (see the policy note above).
UPDATE `users`
   SET `status` = 'approved', `approved_at` = `created_at`, `status_changed_at` = `created_at`
 WHERE `is_active` = 1;

UPDATE `users`
   SET `status` = 'suspended', `status_changed_at` = NOW()
 WHERE `is_active` = 0;

-- ---------------------------------------------------------------------
-- user_audit_logs — who changed which account, when, and why
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_audit_logs` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`        INT UNSIGNED NOT NULL,
  `admin_id`       INT UNSIGNED NULL COMMENT 'administrator who performed the action (NULL = system)',
  `action`         ENUM('approved','rejected','suspended','reactivated') NOT NULL,
  `previous_status` VARCHAR(20) NULL,
  `new_status`     VARCHAR(20) NOT NULL,
  `reason`         VARCHAR(255) NULL COMMENT 'optional administrator supplied reason',
  `ip_address`     VARCHAR(45)  NULL,
  `user_agent`     VARCHAR(255) NULL,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_audit_user` (`user_id`, `created_at`),
  KEY `idx_user_audit_admin` (`admin_id`),
  CONSTRAINT `fk_user_audit_user`  FOREIGN KEY (`user_id`)  REFERENCES `users`  (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_audit_admin` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
