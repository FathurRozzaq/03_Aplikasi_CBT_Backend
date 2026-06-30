-- Tambahkan kolom essay_grades_json ke tabel simulasi_submissions untuk menyimpan detail skor per-soal esai dan umpan balik guru.
ALTER TABLE simulasi_submissions ADD COLUMN essay_grades_json TEXT DEFAULT '{}';
