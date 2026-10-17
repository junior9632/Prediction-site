-- 003: admin-managed API credentials (encrypted at rest) + connection diagnostics.
--
-- WHY
--   Until now the API-Football key lived only in the server environment
--   (API_FOOTBALL_KEY). Rotating it meant editing .env / the cPanel env panel
--   and restarting the app. This migration adds the storage for the admin
--   "API Management" screen, so an administrator can enter, test, save and
--   activate a key from the dashboard without touching application source.
--
-- SECURITY MODEL (enforced in server/utils/credentialVault.js)
--   * the API key is stored ONLY as an AES-256-GCM ciphertext (VARBINARY) with
--     its own random IV and authentication tag — never as plaintext, never in
--     a TEXT column, never in a log line;
--   * the encryption key comes from the server environment variable
--     API_CREDENTIALS_ENCRYPTION_KEY and is never stored in this database;
--   * `key_last4` + `key_length` exist purely for the masked display
--     ("********abcd") — the full value can never be reconstructed from them;
--   * `key_fingerprint` is a SHA-256 of the stored key, used only to detect
--     "the same key was saved again"; it is never returned by an endpoint.
--
-- SAFE DATA POLICY
--   Two NEW tables are created. No existing table, row, column or index is
--   touched or dropped, so applying this migration cannot change the current
--   working setup: while no active row exists in `api_credentials` the server
--   keeps using the environment configuration exactly as before.
--
-- Safe on MySQL 5.7+ / MariaDB 10.3+ (cPanel target). Runs exactly once;
-- recorded with a checksum in `schema_migrations`.

-- ---------------------------------------------------------------------
-- api_credentials — one row per provider (unique key on `provider`)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_credentials` (
  `id`                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider`               VARCHAR(40)  NOT NULL COMMENT 'provider id from server/services/apiProviders.js (allowlisted)',
  `host`                   VARCHAR(120) NOT NULL COMMENT 'API host, must be on the provider allowlist (SSRF guard)',
  `key_ciphertext`         VARBINARY(1024) NOT NULL COMMENT 'AES-256-GCM ciphertext of the API key — the plaintext is never stored',
  `key_iv`                 VARBINARY(16)  NOT NULL COMMENT 'random 12-byte GCM nonce',
  `key_tag`                VARBINARY(16)  NOT NULL COMMENT 'GCM authentication tag (tamper detection)',
  `key_algorithm`          VARCHAR(24)  NOT NULL DEFAULT 'aes-256-gcm',
  `key_id`                 CHAR(16)     NULL COMMENT 'id of the encryption key used (detects a rotated master key)',
  `key_last4`              CHAR(4)      NULL COMMENT 'last 4 characters — for the masked display only',
  `key_length`             SMALLINT UNSIGNED NULL COMMENT 'length of the saved key (diagnostics)',
  `key_fingerprint`        CHAR(64)     NULL COMMENT 'sha256 of the API key: change detection only, never returned',
  `is_active`              TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = the server uses this credential for upstream calls',
  `connection_state`       VARCHAR(30)  NOT NULL DEFAULT 'NOT_TESTED' COMMENT 'CONNECTED | INVALID_KEY | QUOTA_EXCEEDED | RATE_LIMITED | NETWORK_ERROR | TIMEOUT | PROVIDER_UNAVAILABLE | CONFIG_INCOMPLETE | NOT_TESTED',
  `connection_message`     VARCHAR(500) NULL COMMENT 'last real result, as reported by the provider',
  `last_test_at`           DATETIME     NULL,
  `last_test_latency_ms`   INT UNSIGNED NULL,
  `last_success_at`        DATETIME     NULL COMMENT 'last time the provider accepted the credential',
  `last_request_at`        DATETIME     NULL COMMENT 'last upstream request made with this credential',
  `last_error_at`          DATETIME     NULL,
  `last_error_code`        VARCHAR(40)  NULL,
  `last_error_message`     VARCHAR(500) NULL COMMENT 'safe summary — never a key, header or payload',
  `quota_used_today`       INT UNSIGNED NULL COMMENT 'ONLY from the provider /status endpoint — never estimated',
  `quota_limit_day`        INT UNSIGNED NULL,
  `quota_checked_at`       DATETIME     NULL,
  `rate_limit_per_minute`  INT UNSIGNED NULL COMMENT 'configured request budget',
  `plan_name`              VARCHAR(80)  NULL COMMENT 'subscription name reported by the provider',
  `activated_at`           DATETIME     NULL,
  `disabled_at`            DATETIME     NULL,
  `created_by_admin_id`    INT UNSIGNED NULL,
  `updated_by_admin_id`    INT UNSIGNED NULL,
  `created_at`             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_credentials_provider` (`provider`),
  KEY `idx_api_credentials_active` (`is_active`),
  CONSTRAINT `fk_api_credentials_created_by` FOREIGN KEY (`created_by_admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_api_credentials_updated_by` FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- api_connection_events — recent API errors / diagnostics history
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_connection_events` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider`     VARCHAR(40)  NOT NULL,
  `event`        VARCHAR(40)  NOT NULL COMMENT 'SAVED | TEST_OK | TEST_FAILED | ACTIVATED | DISABLED | REQUEST_FAILED | QUOTA_WARNING',
  `outcome`      VARCHAR(30)  NOT NULL COMMENT 'CONNECTED | SUCCESS | INVALID_KEY | QUOTA_EXCEEDED | RATE_LIMITED | NETWORK_ERROR | TIMEOUT | PROVIDER_UNAVAILABLE | CONFIG_INCOMPLETE | ENCRYPTION_KEY_MISSING',
  `http_status`  SMALLINT UNSIGNED NULL,
  `endpoint`     VARCHAR(80)  NULL COMMENT 'API path only (e.g. /status) — never a URL with a credential',
  `latency_ms`   INT UNSIGNED NULL,
  `message`      VARCHAR(500) NULL COMMENT 'safe, human readable summary',
  `context_json` JSON         NULL,
  `admin_id`     INT UNSIGNED NULL,
  `ip_address`   VARCHAR(45)  NULL,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_api_events_provider_time` (`provider`, `created_at`),
  KEY `idx_api_events_outcome` (`outcome`),
  CONSTRAINT `fk_api_events_admin` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
