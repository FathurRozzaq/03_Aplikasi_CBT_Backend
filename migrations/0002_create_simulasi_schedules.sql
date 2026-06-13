-- Migrasi untuk mendukung Multi-Sesi Ujian (Multi-Schedule)
-- 1. Buat tabel simulasi_schedules
CREATE TABLE IF NOT EXISTS simulasi_schedules (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_start INTEGER,
  discussion_open INTEGER DEFAULT 0,
  participants_json TEXT DEFAULT '[]',
  created_at INTEGER,
  FOREIGN KEY (package_id) REFERENCES packages(id)
);

-- 2. Tambahkan kolom schedule_id ke tabel simulasi_sessions & simulasi_submissions
ALTER TABLE simulasi_sessions ADD COLUMN schedule_id TEXT;
ALTER TABLE simulasi_submissions ADD COLUMN schedule_id TEXT;

-- 3. Migrasi Data Lama: Buat sesi jadwal awal untuk paket soal simulasi yang saat ini memiliki jadwal
INSERT INTO simulasi_schedules (id, package_id, title, scheduled_start, discussion_open, participants_json, created_at)
SELECT 
  'legacy_' || id AS id,
  id AS package_id,
  'Sesi Utama - ' || title AS title,
  scheduled_start,
  discussion_open,
  participants_json,
  strftime('%s', 'now') AS created_at
FROM packages 
WHERE app_type = 'simulasi' AND scheduled_start IS NOT NULL;

-- 4. Hubungkan sesi pengerjaan lama ke jadwal legacy
UPDATE simulasi_sessions
SET schedule_id = 'legacy_' || package_id
WHERE schedule_id IS NULL AND EXISTS (
  SELECT 1 FROM simulasi_schedules WHERE id = 'legacy_' || package_id
);

-- 5. Hubungkan hasil nilai lama ke jadwal legacy
UPDATE simulasi_submissions
SET schedule_id = 'legacy_' || package_id
WHERE schedule_id IS NULL AND EXISTS (
  SELECT 1 FROM simulasi_schedules WHERE id = 'legacy_' || package_id
);
