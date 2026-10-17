-- 001: store bookmaker prices without rounding.
--
-- DECIMAL(8,3) silently rounded any price with more than three decimals on
-- write, so the stored decimal no longer matched the exact API string and the
-- odds re-validation (rule 14, "not manually modified") would reject a real
-- price. odd_raw remains the untouched API string; these columns are the exact
-- numeric form of the same value. DECIMAL(12,6) keeps every price exact.
--
-- Safe on MySQL 5.7+ and MariaDB 10.3+. Widening a DECIMAL never drops data.

ALTER TABLE `odds`
  MODIFY `odd_decimal` DECIMAL(12,6) NOT NULL
  COMMENT 'exact numeric form of odd_raw (no rounding)';

ALTER TABLE `ticket_selections`
  MODIFY `odd_decimal` DECIMAL(12,6) NOT NULL
  COMMENT 'SNAPSHOT of the exact published price — never rewritten by later price moves';

ALTER TABLE `predictions`
  MODIFY `selected_odds` DECIMAL(12,6) NULL
  COMMENT 'verified odds actually used (exact API value)';
