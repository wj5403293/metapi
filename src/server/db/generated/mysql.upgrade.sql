ALTER TABLE `downstream_api_keys` ADD COLUMN `group_name` TEXT;
ALTER TABLE `downstream_api_keys` ADD COLUMN `tags` TEXT;
ALTER TABLE `proxy_logs` ADD COLUMN `downstream_api_key_id` INT;
CREATE INDEX `proxy_logs_downstream_api_key_created_at_idx` ON `proxy_logs` (`downstream_api_key_id`, `created_at`);
