-- A separate transaction releases 023's ACCESS EXCLUSIVE lock before scanning existing rows.
ALTER TABLE chat_files VALIDATE CONSTRAINT chat_files_media_type_check;
ALTER TABLE chat_files VALIDATE CONSTRAINT chat_files_content_check;
