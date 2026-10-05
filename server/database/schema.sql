-- =====================================================================
--  FOOTBALL PREDICTIONS — MySQL / MariaDB schema
--  Market: OVER 1.5 GOALS ONLY
--  Engine: MySQL 5.7+ / MariaDB 10.3+ (cPanel compatible, utf8mb4)
--
--  Design rules enforced at schema level:
--   * every odds row belongs to a real fixture + real bookmaker
--   * market/goal line are explicit columns (goal_line DECIMAL(4,2) = 1.50)
--   * tickets are unique per date (one manual ticket per day)
--   * immutable odds snapshots live in ticket_selections (never updated
--     by later bookmaker price changes)
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- users — optional public accounts (site is fully readable without login)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`            VARCHAR(190) NOT NULL,
  `username`         VARCHAR(60)  NOT NULL,
  `password_hash`    VARCHAR(255) NOT NULL,
  `role`             ENUM('user','premium') NOT NULL DEFAULT 'user',
  `is_active`        TINYINT(1)   NOT NULL DEFAULT 1,
  `failed_logins`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`     DATETIME     NULL,
  `last_login_at`    DATETIME     NULL,
  `last_login_ip`    VARCHAR(45)  NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_username` (`username`),
  KEY `idx_users_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- admins — dashboard / ticket generation accounts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `admins` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`            VARCHAR(190) NOT NULL,
  `username`         VARCHAR(60)  NOT NULL,
  `password_hash`    VARCHAR(255) NOT NULL,
  `role`             ENUM('admin','superadmin') NOT NULL DEFAULT 'admin',
  `is_active`        TINYINT(1)   NOT NULL DEFAULT 1,
  `failed_logins`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`     DATETIME     NULL,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
  `last_login_at`    DATETIME     NULL,
  `last_login_ip`    VARCHAR(45)  NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admins_email` (`email`),
  UNIQUE KEY `uq_admins_username` (`username`),
  KEY `idx_admins_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- leagues
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `leagues` (
  `id`               INT UNSIGNED NOT NULL COMMENT 'API-Football league id',
  `name`             VARCHAR(120) NOT NULL,
  `country`          VARCHAR(120) NULL,
  `country_code`     VARCHAR(8)   NULL,
  `logo_url`         VARCHAR(255) NULL,
  `season`           SMALLINT UNSIGNED NULL,
  `type`             VARCHAR(40)  NULL,
  `avg_total_goals`  DECIMAL(5,3) NULL COMMENT 'league goal environment (computed from stored finished fixtures)',
  `avg_home_goals`   DECIMAL(5,3) NULL,
  `avg_away_goals`   DECIMAL(5,3) NULL,
  `over15_rate`      DECIMAL(5,2) NULL COMMENT '% of stored finished league matches with >= 2 goals',
  `sample_matches`   INT UNSIGNED NOT NULL DEFAULT 0,
  `synced_at`        DATETIME     NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_leagues_country` (`country`),
  KEY `idx_leagues_season` (`season`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `teams` (
  `id`               INT UNSIGNED NOT NULL COMMENT 'API-Football team id',
  `name`             VARCHAR(120) NOT NULL,
  `code`             VARCHAR(20)  NULL,
  `country`          VARCHAR(120) NULL,
  `logo_url`         VARCHAR(255) NULL,
  `venue`            VARCHAR(120) NULL,
  `synced_at`        DATETIME     NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_teams_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- fixtures — every fixture we know about (upcoming + finished history)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fixtures` (
  `id`               BIGINT UNSIGNED NOT NULL COMMENT 'API-Football fixture id',
  `league_id`        INT UNSIGNED NULL,
  `league_season`    SMALLINT UNSIGNED NULL,
  `league_round`     VARCHAR(60)  NULL,
  `home_team_id`     INT UNSIGNED NULL,
  `away_team_id`     INT UNSIGNED NULL,
  `home_team_name`   VARCHAR(120) NULL,
  `away_team_name`   VARCHAR(120) NULL,
  `venue_name`       VARCHAR(120) NULL,
  `venue_city`       VARCHAR(120) NULL,
  `referee`          VARCHAR(120) NULL,
  `kickoff_at`       DATETIME     NULL COMMENT 'UTC kickoff',
  `kickoff_tz`       VARCHAR(60)  NULL,
  `status_long`      VARCHAR(60)  NULL,
  `status_short`     VARCHAR(12)  NULL,
  `status_elapsed`   SMALLINT UNSIGNED NULL,
  `is_playable`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = not started, not cancelled/postponed/abandoned',
  `is_finished`      TINYINT(1)   NOT NULL DEFAULT 0,
  `goals_home`       SMALLINT     NULL,
  `goals_away`       SMALLINT     NULL,
  `score_halftime_home` SMALLINT  NULL,
  `score_halftime_away` SMALLINT  NULL,
  `score_extra_home` SMALLINT     NULL,
  `score_extra_away` SMALLINT     NULL,
  `score_penalty_home` SMALLINT   NULL,
  `score_penalty_away` SMALLINT   NULL,
  `api_timestamp`    DATETIME     NULL COMMENT 'fixture.timestamp from API',
  `fetched_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fixtures_kickoff` (`kickoff_at`),
  KEY `idx_fixtures_date_playable` (`kickoff_at`, `is_playable`),
  KEY `idx_fixtures_league_season` (`league_id`, `league_season`),
  KEY `idx_fixtures_home_team` (`home_team_id`, `kickoff_at`),
  KEY `idx_fixtures_away_team` (`away_team_id`, `kickoff_at`),
  KEY `idx_fixtures_finished` (`is_finished`, `kickoff_at`),
  CONSTRAINT `fk_fixtures_league` FOREIGN KEY (`league_id`) REFERENCES `leagues` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_fixtures_home`   FOREIGN KEY (`home_team_id`) REFERENCES `teams` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_fixtures_away`   FOREIGN KEY (`away_team_id`) REFERENCES `teams` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- bookmakers — real bookmakers only, as returned by API-Football
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `bookmakers` (
  `id`               INT UNSIGNED NOT NULL COMMENT 'API-Football bookmaker id',
  `name`             VARCHAR(120) NOT NULL,
  `is_active`        TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bookmakers_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- odds — verified prices pulled from API-Football.
--        market_key 'over_1_5' rows are the ONLY rows the engine may use.
--        goal_line is stored explicitly so Over 2.5 can never be mistaken
--        for Over 1.5.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `odds` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fixture_id`       BIGINT UNSIGNED NOT NULL,
  `bookmaker_id`     INT UNSIGNED NOT NULL,
  `bookmaker_name`   VARCHAR(120) NOT NULL,
  `market_key`       VARCHAR(40)  NOT NULL COMMENT 'over_1_5 | over_2_5 | under_1_5 | other (stored for audit only)',
  `market_label`     VARCHAR(80)  NOT NULL COMMENT 'exact label from API, e.g. "Over 1.5 Goals"',
  `bet_name`         VARCHAR(80)  NOT NULL COMMENT 'API bet group name, e.g. "Over/Under", "Total Goals"',
  `value_name`       VARCHAR(80)  NOT NULL COMMENT 'API value name, e.g. "Over 1.5"',
  `goal_line`        DECIMAL(4,2) NOT NULL COMMENT 'parsed goal line; 1.50 for the only tradable market',
  `direction`        ENUM('over','under','other') NOT NULL DEFAULT 'over',
  `odd_decimal`      DECIMAL(8,3) NOT NULL,
  `odd_raw`          VARCHAR(40)  NOT NULL COMMENT 'exact string returned by the API',
  `is_verified`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'passed every odds validation rule',
  `validation_state` VARCHAR(30)  NOT NULL DEFAULT 'PENDING' COMMENT 'VERIFIED | REJECTED | PENDING',
  `reject_reason`    VARCHAR(80)  NULL,
  `odds_updated_at`  DATETIME     NULL COMMENT 'API "update" timestamp for the odds payload',
  `fetched_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_odds_fixture_book_market_line_dir` (`fixture_id`, `bookmaker_id`, `market_key`, `goal_line`, `direction`),
  KEY `idx_odds_fixture_market` (`fixture_id`, `market_key`),
  KEY `idx_odds_verified` (`is_verified`, `market_key`),
  KEY `idx_odds_updated` (`odds_updated_at`),
  KEY `idx_odds_fetched` (`fetched_at`),
  CONSTRAINT `fk_odds_fixture`   FOREIGN KEY (`fixture_id`)   REFERENCES `fixtures` (`id`)   ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_odds_bookmaker` FOREIGN KEY (`bookmaker_id`) REFERENCES `bookmakers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- predictions — one Over 1.5 prediction per fixture (server computed)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `predictions` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fixture_id`       BIGINT UNSIGNED NOT NULL,
  `market_key`       VARCHAR(40)  NOT NULL DEFAULT 'over_1_5',
  `market_label`     VARCHAR(80)  NOT NULL DEFAULT 'Over 1.5 Goals',
  `is_eligible`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'has verified Over 1.5 odds + enough data',
  `reject_reason`    VARCHAR(80)  NULL COMMENT 'NO_OVER15_ODDS | INSUFFICIENT_DATA | DATA_UNAVAILABLE | ODDS_STALE | FIXTURE_STARTED | FIXTURE_NOT_PLAYABLE | LOW_CONFIDENCE | HIGH_RISK | LOW_QUALITY | CORRELATION',
  `confidence`       DECIMAL(5,2) NULL COMMENT '0-100, computed from real data only',
  `quality_score`    DECIMAL(5,2) NULL,
  `risk_score`       DECIMAL(5,2) NULL,
  `model_probability` DECIMAL(6,4) NULL COMMENT 'P(total goals >= 2) from the Poisson model',
  `market_probability` DECIMAL(6,4) NULL COMMENT '1 / verified decimal odds (implied)',
  `expected_goals_home` DECIMAL(6,3) NULL,
  `expected_goals_away` DECIMAL(6,3) NULL,
  `expected_total_goals` DECIMAL(6,3) NULL,
  `home_over15_rate` DECIMAL(5,2) NULL COMMENT '% of last N home team matches with >= 2 total goals',
  `away_over15_rate` DECIMAL(5,2) NULL,
  `h2h_over15_rate`  DECIMAL(5,2) NULL,
  `h2h_sample`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `home_form_sample` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `away_form_sample` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `data_quality`     DECIMAL(5,2) NULL COMMENT '0-100 completeness/freshness',
  `injuries_home`    SMALLINT UNSIGNED NULL COMMENT 'NULL = DATA UNAVAILABLE',
  `injuries_away`    SMALLINT UNSIGNED NULL,
  `selected_odds`    DECIMAL(8,3) NULL COMMENT 'verified odds actually used (exact API value)',
  `selected_bookmaker_id` INT UNSIGNED NULL,
  `selected_bookmaker_name` VARCHAR(120) NULL,
  `odds_updated_at`  DATETIME     NULL,
  `odds_verified_at` DATETIME     NULL,
  `analysis_json`    JSON         NULL COMMENT 'full transparent breakdown of every input used',
  `generated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_predictions_fixture` (`fixture_id`, `market_key`),
  KEY `idx_predictions_eligible` (`is_eligible`, `confidence`),
  KEY `idx_predictions_generated` (`generated_at`),
  KEY `idx_predictions_reject` (`reject_reason`),
  CONSTRAINT `fk_predictions_fixture` FOREIGN KEY (`fixture_id`) REFERENCES `fixtures` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- prediction_scores — every scoring component, kept for auditability
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `prediction_scores` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `prediction_id`    BIGINT UNSIGNED NOT NULL,
  `fixture_id`       BIGINT UNSIGNED NOT NULL,
  `component`        VARCHAR(60)  NOT NULL COMMENT 'e.g. attack_strength_home, over15_history, data_freshness, injury_penalty, market_agreement',
  `score`            DECIMAL(10,4) NOT NULL DEFAULT 0,
  `weight`           DECIMAL(6,4) NOT NULL DEFAULT 0,
  `contribution`     DECIMAL(10,4) NOT NULL DEFAULT 0,
  `detail_json`      JSON         NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_scores_prediction_component` (`prediction_id`, `component`),
  KEY `idx_scores_fixture` (`fixture_id`),
  CONSTRAINT `fk_scores_prediction` FOREIGN KEY (`prediction_id`) REFERENCES `predictions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- tickets — one manual ticket per day (never auto published)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tickets` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_date`      DATE         NOT NULL COMMENT 'the day the ticket applies to',
  `market_key`       VARCHAR(40)  NOT NULL DEFAULT 'over_1_5',
  `market_label`     VARCHAR(80)  NOT NULL DEFAULT 'Over 1.5 Goals',
  `status`           VARCHAR(30)  NOT NULL DEFAULT 'QUALIFIED' COMMENT 'QUALIFIED | NO_QUALIFYING_TICKET | DATA_SOURCE_UNAVAILABLE | PENDING | ERROR',
  `selection_count`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `total_odds`       DECIMAL(12,6) NOT NULL DEFAULT 0 COMMENT 'exact product of verified odds',
  `total_odds_display` VARCHAR(20) NOT NULL DEFAULT '0.00',
  `avg_confidence`   DECIMAL(5,2) NULL,
  `min_confidence`   DECIMAL(5,2) NULL,
  `avg_quality`      DECIMAL(5,2) NULL,
  `max_risk`         DECIMAL(5,2) NULL,
  `estimated_probability` DECIMAL(6,4) NULL,
  `result`           VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | WON | LOST | VOID | PARTIAL_VOID | POSTPONED',
  `settled_odds`     DECIMAL(12,6) NULL COMMENT 'odds after void legs removed',
  `settled_at`       DATETIME     NULL,
  `result_note`      VARCHAR(255) NULL,
  `min_total_odds`   DECIMAL(8,3) NOT NULL DEFAULT 2.000 COMMENT 'settings used at generation time',
  `max_total_odds`   DECIMAL(8,3) NOT NULL DEFAULT 4.000,
  `generation_id`    BIGINT UNSIGNED NULL,
  `generated_by_admin_id` INT UNSIGNED NULL,
  `generated_at`     DATETIME     NULL,
  `published`        TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tickets_date` (`ticket_date`),
  KEY `idx_tickets_status` (`status`),
  KEY `idx_tickets_result` (`result`),
  KEY `idx_tickets_generated_at` (`generated_at`),
  CONSTRAINT `fk_tickets_admin` FOREIGN KEY (`generated_by_admin_id`) REFERENCES `admins` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ticket_selections — IMMUTABLE odds snapshot per pick
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `ticket_selections` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_id`        BIGINT UNSIGNED NOT NULL,
  `fixture_id`       BIGINT UNSIGNED NOT NULL,
  `prediction_id`    BIGINT UNSIGNED NULL,
  `position`         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `league_id`        INT UNSIGNED NULL,
  `league_name`      VARCHAR(120) NULL,
  `league_country`   VARCHAR(120) NULL,
  `league_logo_url`  VARCHAR(255) NULL,
  `home_team_id`     INT UNSIGNED NULL,
  `away_team_id`     INT UNSIGNED NULL,
  `home_team_name`   VARCHAR(120) NULL,
  `away_team_name`   VARCHAR(120) NULL,
  `home_team_logo`   VARCHAR(255) NULL,
  `away_team_logo`   VARCHAR(255) NULL,
  `kickoff_at`       DATETIME     NULL,
  `market_key`       VARCHAR(40)  NOT NULL DEFAULT 'over_1_5',
  `market_label`     VARCHAR(80)  NOT NULL DEFAULT 'Over 1.5 Goals',
  `bookmaker_id`     INT UNSIGNED NULL,
  `bookmaker_name`   VARCHAR(120) NULL,
  `odd_decimal`      DECIMAL(8,3) NOT NULL COMMENT 'SNAPSHOT — never rewritten by later price moves',
  `odd_raw`          VARCHAR(40)  NULL,
  `odds_updated_at`  DATETIME     NULL COMMENT 'API odds timestamp at snapshot time',
  `odds_verified_at` DATETIME     NOT NULL COMMENT 'moment the server verified the price',
  `confidence`       DECIMAL(5,2) NOT NULL,
  `quality_score`    DECIMAL(5,2) NULL,
  `risk_score`       DECIMAL(5,2) NULL,
  `model_probability` DECIMAL(6,4) NULL,
  `result`           VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | WON | LOST | VOID | POSTPONED',
  `final_home_goals` SMALLINT     NULL,
  `final_away_goals` SMALLINT     NULL,
  `final_total_goals` SMALLINT    NULL,
  `settled_at`       DATETIME     NULL,
  `snapshot_json`    JSON         NULL COMMENT 'complete frozen input snapshot used for the pick',
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_selections_ticket_fixture` (`ticket_id`, `fixture_id`),
  KEY `idx_selections_fixture` (`fixture_id`),
  KEY `idx_selections_result` (`result`),
  KEY `idx_selections_kickoff` (`kickoff_at`),
  CONSTRAINT `fk_selections_ticket`  FOREIGN KEY (`ticket_id`)  REFERENCES `tickets` (`id`)     ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_selections_fixture` FOREIGN KEY (`fixture_id`) REFERENCES `fixtures` (`id`)   ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_selections_prediction` FOREIGN KEY (`prediction_id`) REFERENCES `predictions` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- results — settled final scores from API-Football (never invented)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `results` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fixture_id`       BIGINT UNSIGNED NOT NULL,
  `status_short`     VARCHAR(12)  NULL,
  `status_long`      VARCHAR(60)  NULL,
  `goals_home`       SMALLINT     NULL,
  `goals_away`       SMALLINT     NULL,
  `total_goals`      SMALLINT     NULL,
  `over15_result`    VARCHAR(20)  NULL COMMENT 'WON (>=2 goals) | LOST (0-1 goals) | VOID | POSTPONED',
  `settled`          TINYINT(1)   NOT NULL DEFAULT 0,
  `settled_at`       DATETIME     NULL,
  `source`           VARCHAR(40)  NOT NULL DEFAULT 'api-football',
  `raw_json`         JSON         NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_results_fixture` (`fixture_id`),
  KEY `idx_results_settled` (`settled`),
  KEY `idx_results_over15` (`over15_result`),
  CONSTRAINT `fk_results_fixture` FOREIGN KEY (`fixture_id`) REFERENCES `fixtures` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- team_form — rolling per-team goal profile (computed from stored results)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `team_form` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `team_id`          INT UNSIGNED NOT NULL,
  `scope`            VARCHAR(20)  NOT NULL COMMENT 'all | home | away',
  `window_matches`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `matches_played`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `goals_for`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `goals_against`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `avg_goals_for`    DECIMAL(6,3) NOT NULL DEFAULT 0,
  `avg_goals_against` DECIMAL(6,3) NOT NULL DEFAULT 0,
  `over15_hits`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `over15_rate`      DECIMAL(5,2) NOT NULL DEFAULT 0,
  `over25_hits`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `clean_sheets`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `failed_to_score`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `wins`             SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `draws`            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `losses`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `form_string`      VARCHAR(20)  NULL COMMENT 'e.g. WWDLW (most recent last)',
  `total_goals_stddev` DECIMAL(6,3) NULL,
  `last_match_at`    DATETIME     NULL,
  `computed_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_team_form_scope` (`team_id`, `scope`, `window_matches`),
  KEY `idx_team_form_team` (`team_id`),
  CONSTRAINT `fk_team_form_team` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- settings — key/value store, admin editable
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `setting_key`      VARCHAR(80)  NOT NULL,
  `setting_value`    TEXT         NULL,
  `value_type`       VARCHAR(20)  NOT NULL DEFAULT 'string' COMMENT 'string | number | boolean | json',
  `group_name`       VARCHAR(40)  NOT NULL DEFAULT 'general',
  `label`            VARCHAR(160) NULL,
  `description`      VARCHAR(500) NULL,
  `is_locked`        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = cannot be weakened from the UI (market, auto generation)',
  `min_value`        DECIMAL(12,4) NULL,
  `max_value`        DECIMAL(12,4) NULL,
  `updated_by`       INT UNSIGNED NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_key` (`setting_key`),
  KEY `idx_settings_group` (`group_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- api_sync_logs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_sync_logs` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job`              VARCHAR(40)  NOT NULL COMMENT 'fixtures | odds | results | injuries | h2h | statistics | status',
  `trigger_source`   VARCHAR(20)  NOT NULL DEFAULT 'cron' COMMENT 'cron | scheduler | manual',
  `status`           VARCHAR(20)  NOT NULL DEFAULT 'SUCCESS' COMMENT 'SUCCESS | FAILED | PARTIAL | SKIPPED',
  `endpoint_calls`   INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_written`     INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_read`        INT UNSIGNED NOT NULL DEFAULT 0,
  `requests_used`    INT UNSIGNED NULL COMMENT 'API-Football requests used today (from /status)',
  `requests_limit`   INT UNSIGNED NULL,
  `message`          VARCHAR(500) NULL,
  `error_detail`     TEXT         NULL,
  `duration_ms`      INT UNSIGNED NULL,
  `started_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`      DATETIME     NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sync_job_time` (`job`, `started_at`),
  KEY `idx_sync_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- generation_logs — one row per manual "GENERATE TODAY'S TICKET" run
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `generation_logs` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_id`        BIGINT UNSIGNED NULL,
  `ticket_date`      DATE         NOT NULL,
  `trigger_source`   VARCHAR(20)  NOT NULL DEFAULT 'admin_ui' COMMENT 'admin_ui | admin_api | cli_manual (NEVER cron)',
  `admin_id`         INT UNSIGNED NULL,
  `status`           VARCHAR(30)  NOT NULL COMMENT 'RUNNING | QUALIFIED | NO_QUALIFYING_TICKET | DATA_SOURCE_UNAVAILABLE | ERROR',
  `progress_step`    VARCHAR(60)  NULL,
  `progress_json`    JSON         NULL COMMENT 'ordered list of progress messages shown in the dashboard',
  `fixtures_scanned` INT UNSIGNED NOT NULL DEFAULT 0,
  `over15_candidates` INT UNSIGNED NOT NULL DEFAULT 0,
  `verified_odds`    INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_matches` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_no_odds` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_low_confidence` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_high_risk` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_low_quality` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_insufficient_data` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_fixture_state` INT UNSIGNED NOT NULL DEFAULT 0,
  `rejected_stale_odds` INT UNSIGNED NOT NULL DEFAULT 0,
  `correlation_rejected` INT UNSIGNED NOT NULL DEFAULT 0,
  `confidence_qualified` INT UNSIGNED NOT NULL DEFAULT 0,
  `risk_qualified`   INT UNSIGNED NOT NULL DEFAULT 0,
  `final_candidates` INT UNSIGNED NOT NULL DEFAULT 0,
  `combinations_tested` INT UNSIGNED NOT NULL DEFAULT 0,
  `qualified_combinations` INT UNSIGNED NOT NULL DEFAULT 0,
  `selected_picks`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `total_odds`       DECIMAL(12,6) NULL,
  `settings_snapshot_json` JSON NULL,
  `report_json`      JSON         NULL,
  `error_detail`     TEXT         NULL,
  `duration_ms`      INT UNSIGNED NULL,
  `started_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`      DATETIME     NULL,
  PRIMARY KEY (`id`),
  KEY `idx_generation_date` (`ticket_date`),
  KEY `idx_generation_status` (`status`),
  KEY `idx_generation_started` (`started_at`),
  CONSTRAINT `fk_generation_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_generation_admin`  FOREIGN KEY (`admin_id`)  REFERENCES `admins` (`id`)  ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- system_logs — audit trail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `system_logs` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `level`            VARCHAR(10)  NOT NULL DEFAULT 'info' COMMENT 'debug | info | warn | error | critical',
  `channel`          VARCHAR(40)  NOT NULL DEFAULT 'app',
  `event`            VARCHAR(80)  NOT NULL,
  `message`          VARCHAR(1000) NULL,
  `actor_type`       VARCHAR(20)  NULL COMMENT 'admin | user | system | cron',
  `actor_id`         INT UNSIGNED NULL,
  `ip_address`       VARCHAR(45)  NULL,
  `user_agent`       VARCHAR(255) NULL,
  `context_json`     JSON         NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_logs_level_time` (`level`, `created_at`),
  KEY `idx_logs_event` (`event`),
  KEY `idx_logs_channel` (`channel`, `created_at`),
  KEY `idx_logs_actor` (`actor_type`, `actor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
