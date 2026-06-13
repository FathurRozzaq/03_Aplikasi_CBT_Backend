import { Hono } from 'hono';

const simulasi = new Hono();

// Helper to force submit expired sessions
async function checkAndForceSubmit(db, session) {
  if (!session || session.status !== 'ongoing') return session;

  const now = Math.floor(Date.now() / 1000);
  const totalDurationSeconds = session.duration * 60;
  if (session.started_at + totalDurationSeconds < now) {
    const packageId = session.package_id;
    const studentId = session.student_id;
    const sessionId = session.id;

    // Fetch package to setup analysis subtopics
    const packageData = await db.prepare(
      'SELECT questions_json FROM packages WHERE id = ? AND app_type = "simulasi"'
    ).bind(packageId).first();

    let analysis = {};
    if (packageData) {
      const questions = JSON.parse(packageData.questions_json || '[]');
      questions.forEach((q) => {
        const subtopic = q.subtopic || 'Umum';
        if (!analysis[subtopic]) {
          analysis[subtopic] = { correct: 0, total: 0 };
        }
        analysis[subtopic].total += 1;
      });
    }

    const submissionId = `${studentId}_${packageId}`;

    await db.batch([
      db.prepare(
        'UPDATE simulasi_sessions SET status = "submitted", submitted_at = ? WHERE id = ?'
      ).bind(now, sessionId),
      db.prepare(
        `INSERT OR REPLACE INTO simulasi_submissions 
         (id, student_id, package_id, score_mcq, score_essay, answers_json, analysis_json, submitted_at) 
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?)`
      ).bind(
        submissionId,
        studentId,
        packageId,
        JSON.stringify({}),
        JSON.stringify(analysis),
        now
      )
    ]);

    session.status = 'submitted';
    session.submitted_at = now;
  }
  return session;
}

// ==========================================
// PORTAL PESERTA (STUDENT PORTAL)
// ==========================================

// 0. Ambil Daftar Paket Simulasi Siswa (Aman): GET /api/simulasi/packages/:studentId
simulasi.get('/packages/:studentId', async (c) => {
  try {
    const studentId = c.req.param('studentId');

    const { results } = await c.env.DB.prepare(
      'SELECT id, title, subject, duration, questions_count, scheduled_start, scheduled_end, participants_json, discussion_open FROM packages WHERE app_type = "simulasi" AND is_active = 1 AND scheduled_start IS NOT NULL'
    ).all();

    const filteredResults = results.filter(pkg => {
      try {
        const participants = JSON.parse(pkg.participants_json || '[]');
        return participants.includes(studentId);
      } catch (e) {
        return false;
      }
    }).map(pkg => {
      const { participants_json, ...rest } = pkg;
      return rest;
    });

    return c.json(filteredResults, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat paket simulasi siswa', details: err.message }, 500);
  }
});

// 1. Mulai Ujian: POST /api/simulasi/start
simulasi.post('/start', async (c) => {
  try {
    const { studentId, packageId } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!studentId || !packageId) {
      return c.json({ error: 'Student ID dan Package ID wajib diisi' }, 400);
    }

    // A. Ambil jadwal ujian paket
    const packageData = await c.env.DB.prepare(
      'SELECT scheduled_start, scheduled_end FROM packages WHERE id = ? AND app_type = "simulasi"'
    ).bind(packageId).first();

    if (!packageData) {
      return c.json({ error: 'Paket simulasi tidak ditemukan' }, 404);
    }

    // B. Verifikasi rentang waktu pengerjaan
    if (packageData.scheduled_start && now < packageData.scheduled_start) {
      return c.json({ error: 'Ujian simulasi belum dimulai' }, 400);
    }

    if (packageData.scheduled_end && now > packageData.scheduled_end) {
      return c.json({ error: 'Ujian simulasi sudah berakhir/ditutup' }, 400);
    }

    // C. Cek apakah sesi sudah pernah dibuat
    const existingSession = await c.env.DB.prepare(
      'SELECT id, status FROM simulasi_sessions WHERE student_id = ? AND package_id = ?'
    ).bind(studentId, packageId).first();

    if (existingSession) {
      if (existingSession.status === 'submitted') {
        return c.json({ error: 'Anda sudah pernah menyelesaikan paket simulasi ini. Batas pengerjaan 1x.' }, 403);
      }
      // Jika masih ongoing, kembalikan sesi yang ada (reload recovery)
      return c.json({ sessionId: existingSession.id, status: 'ongoing' }, 200);
    }

    // D. Buat sesi baru
    const sessionId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO simulasi_sessions (id, student_id, package_id, status, started_at) VALUES (?, ?, ?, "ongoing", ?)'
    ).bind(sessionId, studentId, packageId, now).run();

    return c.json({ sessionId, status: 'ongoing' }, 201);

  } catch (err) {
    return c.json({ error: 'Gagal memulai sesi ujian', details: err.message }, 500);
  }
});

// 2. Pemulihan Sesi (Reload Recovery): GET /api/simulasi/session/:sessionId
simulasi.get('/session/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    let session = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.status, ss.tab_switch_count, ss.started_at, p.duration, p.title
       FROM simulasi_sessions ss
       JOIN packages p ON ss.package_id = p.id
       WHERE ss.id = ?`
    ).bind(sessionId).first();

    if (!session) {
      return c.json({ error: 'Sesi ujian tidak ditemukan' }, 404);
    }

    session = await checkAndForceSubmit(c.env.DB, session);

    return c.json({ success: true, session }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat sesi', details: err.message }, 500);
  }
});

// 2b. Ambil Soal Ujian (Hanya jika sesi aktif & Sembunyikan Kunci Jawaban): GET /api/simulasi/questions/:packageId/:sessionId
simulasi.get('/questions/:packageId/:sessionId', async (c) => {
  try {
    const packageId = c.req.param('packageId');
    const sessionId = c.req.param('sessionId');

    let session = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.status, ss.started_at, p.duration 
       FROM simulasi_sessions ss 
       JOIN packages p ON ss.package_id = p.id 
       WHERE ss.id = ? AND ss.package_id = ?`
    ).bind(sessionId, packageId).first();

    if (!session) {
      return c.json({ error: 'Sesi tidak ditemukan' }, 404);
    }

    session = await checkAndForceSubmit(c.env.DB, session);

    if (session.status !== 'ongoing') {
      return c.json({ error: 'Akses ditolak. Sesi tidak aktif atau sudah selesai dikerjakan.' }, 403);
    }

    const packageData = await c.env.DB.prepare(
      'SELECT id, title, subject, duration, questions_json FROM packages WHERE id = ?'
    ).bind(packageId).first();

    if (!packageData) {
      return c.json({ error: 'Paket simulasi tidak ditemukan' }, 404);
    }

    const questions = JSON.parse(packageData.questions_json || '[]');

    // Sembunyikan correct_answer dan explanation saat pengerjaan agar aman dari inspect element
    const clientQuestions = questions.map((q) => {
      const { correct_answer, explanation, ...rest } = q;
      return rest;
    });

    return c.json({
      success: true,
      id: packageData.id,
      title: packageData.title,
      subject: packageData.subject,
      duration: packageData.duration,
      questions: clientQuestions
    }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal memuat soal ujian', details: err.message }, 500);
  }
});

// 3. Laporkan Pelanggaran: POST /api/simulasi/violation
simulasi.post('/violation', async (c) => {
  try {
    const { sessionId } = await c.req.json();

    if (!sessionId) {
      return c.json({ error: 'Session ID wajib diisi' }, 400);
    }

    const result = await c.env.DB.prepare(
      'UPDATE simulasi_sessions SET tab_switch_count = tab_switch_count + 1 WHERE id = ? AND status = "ongoing"'
    ).bind(sessionId).run();

    return c.json({ success: true, changes: result.meta.changes }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal mencatat pelanggaran', details: err.message }, 500);
  }
});

// 4. Kirim Ujian & Penilaian Pilihan Ganda: POST /api/simulasi/submit
simulasi.post('/submit', async (c) => {
  try {
    const { studentId, packageId, sessionId, answers } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!studentId || !packageId || !sessionId || !answers) {
      return c.json({ error: 'Data pengerjaan tidak lengkap' }, 400);
    }

    // A. Ambil butir soal dari database
    const packageData = await c.env.DB.prepare(
      'SELECT questions_json FROM packages WHERE id = ? AND app_type = "simulasi"'
    ).bind(packageId).first();

    if (!packageData) {
      return c.json({ error: 'Paket simulasi tidak ditemukan' }, 404);
    }

    const questions = JSON.parse(packageData.questions_json || '[]');
    let correctMcqCount = 0;
    let totalMcqCount = 0;
    const analysis = {}; // Akurasi per subtopik: { [subtopic]: { correct: 0, total: 0 } }

    // B. Hitung skor MCQ dan kumpulkan analisis subtopik
    questions.forEach((q) => {
      const subtopic = q.subtopic || 'Umum';
      const isMcq = q.type === 'mcq' || !q.type;
      const studentAnswer = answers[q.id] || '';

      if (!analysis[subtopic]) {
        analysis[subtopic] = { correct: 0, total: 0 };
      }
      analysis[subtopic].total += 1;

      if (isMcq) {
        totalMcqCount += 1;
        if (studentAnswer.toString().toUpperCase() === q.correct_answer.toString().toUpperCase()) {
          correctMcqCount += 1;
          analysis[subtopic].correct += 1;
        }
      }
    });

    const scoreMcq = totalMcqCount > 0 ? (correctMcqCount / totalMcqCount) * 100 : 0;
    const submissionId = `${studentId}_${packageId}`;

    // C. Simpan ke Database (Batch Transaction)
    await c.env.DB.batch([
      // Update status sesi
      c.env.DB.prepare(
        'UPDATE simulasi_sessions SET status = "submitted", submitted_at = ? WHERE id = ?'
      ).bind(now, sessionId),
      // Simpan berkas hasil ujian
      c.env.DB.prepare(
        `INSERT OR REPLACE INTO simulasi_submissions 
         (id, student_id, package_id, score_mcq, score_essay, answers_json, analysis_json, submitted_at) 
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
      ).bind(
        submissionId,
        studentId,
        packageId,
        scoreMcq,
        JSON.stringify(answers),
        JSON.stringify(analysis),
        now
      )
    ]);

    return c.json({
      success: true,
      scoreMcq,
      analysis
    }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal mengumpulkan lembar jawaban', details: err.message }, 500);
  }
});

// 4b. Ambil Hasil Ujian Siswa (Aman): GET /api/simulasi/submission/:packageId/:studentId
simulasi.get('/submission/:packageId/:studentId', async (c) => {
  try {
    const packageId = c.req.param('packageId');
    const studentId = c.req.param('studentId');

    const submission = await c.env.DB.prepare(
      `SELECT score_mcq, score_essay, answers_json, analysis_json, submitted_at 
       FROM simulasi_submissions 
       WHERE student_id = ? AND package_id = ?`
    ).bind(studentId, packageId).first();

    if (!submission) {
      return c.json({ error: 'Hasil pengerjaan tidak ditemukan' }, 404);
    }

    return c.json({
      success: true,
      submission
    }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal mengambil hasil ujian', details: err.message }, 500);
  }
});

// 4c. Ambil Pembahasan & Kunci Soal (Aman & Terkunci): GET /api/simulasi/discussion/:packageId/:sessionId
simulasi.get('/discussion/:packageId/:sessionId', async (c) => {
  try {
    const packageId = c.req.param('packageId');
    const sessionId = c.req.param('sessionId');

    // A. Validasi Sesi: Pastikan sesi sudah submitted
    const session = await c.env.DB.prepare(
      'SELECT status FROM simulasi_sessions WHERE id = ? AND package_id = ?'
    ).bind(sessionId, packageId).first();

    if (!session || session.status !== 'submitted') {
      return c.json({ error: 'Akses ditolak. Sesi belum dikirim/selesai.' }, 403);
    }

    // B. Validasi Pembahasan: Pastikan sudah dibuka oleh admin
    const packageData = await c.env.DB.prepare(
      'SELECT id, title, subject, questions_json, discussion_open FROM packages WHERE id = ?'
    ).bind(packageId).first();

    if (!packageData) {
      return c.json({ error: 'Paket simulasi tidak ditemukan' }, 404);
    }

    if (packageData.discussion_open !== 1 && packageData.discussion_open !== true) {
      return c.json({ error: 'Pembahasan belum dibuka oleh admin.', discussionOpen: false }, 403);
    }

    const questions = JSON.parse(packageData.questions_json || '[]');

    return c.json({
      success: true,
      id: packageData.id,
      title: packageData.title,
      subject: packageData.subject,
      questions
    }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal memuat pembahasan', details: err.message }, 500);
  }
});

// 5. Proxy AI Chat Isa (Gemini): POST /api/simulasi/chat-isa
simulasi.post('/chat-isa', async (c) => {
  try {
    const { studentId, sessionId, message } = await c.req.json();
    const today = new Date().toISOString().split('T')[0];

    if (!studentId || !sessionId || !message) {
      return c.json({ error: 'Payload tidak lengkap' }, 400);
    }

    // A. Validasi Sesi: Pastikan user sudah menyelesaikan ujian
    const session = await c.env.DB.prepare(
      'SELECT status FROM simulasi_sessions WHERE id = ?'
    ).bind(sessionId).first();

    if (!session || session.status !== 'submitted') {
      return c.json({ error: 'AI Chat pembahasan hanya terbuka setelah ujian Anda dikirimkan' }, 403);
    }

    // B. Cek Quota limit harian (120/hari)
    let chatHistory = await c.env.DB.prepare(
      'SELECT id, messages_json, daily_count, last_reset_date FROM simulasi_chat_histories WHERE student_id = ? AND session_id = ?'
    ).bind(studentId, sessionId).first();

    let dailyCount = 0;
    let messages = [];

    if (chatHistory) {
      if (chatHistory.last_reset_date === today) {
        dailyCount = chatHistory.daily_count;
      } else {
        dailyCount = 0;
      }

      if (dailyCount >= 120) {
        return c.json({ error: 'Batas kuota harian Anda (120 chat/hari) untuk asisten Isa telah habis' }, 429);
      }
      messages = JSON.parse(chatHistory.messages_json || '[]');
    }

    // C. Panggil Gemini API Pro via HTTP Fetch
    const systemInstructionText = 'Kamu adalah Isa, seorang tutor pendamping belajar yang santai, bersahabat, dan suportif untuk membantu peserta memahami pembahasan soal ujian. Jangan sebutkan kata "Gemini", "Google", "AI", atau "Asisten Virtual" di dalam penjelasanmu. Cukup panggil dirimu sebagai "Isa". Gunakan bahasa Indonesia yang santai, akrab, ramah, dan tidak formal/kaku (seperti mengobrol dengan teman dekat atau kakak tutor). PENTING: Jangan pernah menggunakan kata "Anda"! Selalu gunakan kata "kamu" untuk menyapa pengguna. Gunakan format Markdown untuk penulisan matematika / rumus jika diperlukan.';
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${c.env.GEMINI_API_KEY}`;

    const contents = [
      ...messages.map(m => ({
        role: m.sender === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemInstructionText }]
        }
      })
    });

    const data = await response.json();
    const botReply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, sistem asisten Isa sedang mengalami kendala. Coba beberapa saat lagi.';

    // D. Simpan Riwayat Baru ke D1
    messages.push({ sender: 'user', text: message, timestamp: Date.now() });
    messages.push({ sender: 'isa', text: botReply, timestamp: Date.now() });
    dailyCount += 1;

    if (chatHistory) {
      await c.env.DB.prepare(
        `UPDATE simulasi_chat_histories 
         SET messages_json = ?, daily_count = ?, last_reset_date = ?, updated_at = ? 
         WHERE id = ?`
      ).bind(JSON.stringify(messages), dailyCount, today, Math.floor(Date.now() / 1000), chatHistory.id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO simulasi_chat_histories 
         (student_id, session_id, messages_json, daily_count, last_reset_date, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(studentId, sessionId, JSON.stringify(messages), dailyCount, today, Math.floor(Date.now() / 1000)).run();
    }

    return c.json({ reply: botReply }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal menghubungi asisten virtual Isa', details: err.message }, 500);
  }
});

// ==========================================
// PORTAL ADMIN (ADMIN PORTAL)
// ==========================================

// 6. Ambil Daftar Paket Simulasi: GET /api/simulasi/admin/packages
simulasi.get('/admin/packages', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, title, subject, duration, questions_count, is_active, scheduled_start, scheduled_end, discussion_open, participants_json FROM packages WHERE app_type = "simulasi"'
    ).all();

    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat paket soal simulasi', details: err.message }, 500);
  }
});

// 7. Edit Jadwal Ujian: PATCH /api/simulasi/admin/packages/:id/schedule
simulasi.patch('/admin/packages/:id/schedule', async (c) => {
  try {
    const packageId = c.req.param('id');
    const { scheduledStart, scheduledEnd } = await c.req.json(); // UNIX Timestamp (INTEGER)

    await c.env.DB.prepare(
      'UPDATE packages SET scheduled_start = ?, scheduled_end = ? WHERE id = ? AND app_type = "simulasi"'
    ).bind(scheduledStart, scheduledEnd, packageId).run();

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memperbarui jadwal', details: err.message }, 500);
  }
});

// 7b. Edit Jadwal & Peserta Ujian: PATCH /api/simulasi/admin/packages/:id/schedule-participants
simulasi.patch('/admin/packages/:id/schedule-participants', async (c) => {
  try {
    const packageId = c.req.param('id');
    const { scheduledStart, participants } = await c.req.json(); // scheduledStart: UNIX timestamp or null, participants: array of student ids

    await c.env.DB.prepare(
      'UPDATE packages SET scheduled_start = ?, scheduled_end = NULL, participants_json = ? WHERE id = ? AND app_type = "simulasi"'
    ).bind(scheduledStart, JSON.stringify(participants || []), packageId).run();

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memperbarui jadwal dan peserta', details: err.message }, 500);
  }
});

// 7c. Ambil Daftar Siswa Pro2: GET /api/simulasi/admin/students
simulasi.get('/admin/students', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT id, nama, nomor_wa, email FROM students WHERE tier = 'pro2' ORDER BY nama ASC"
    ).all();
    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat data siswa', details: err.message }, 500);
  }
});

// 8. Buka/Tutup Pembahasan: PATCH /api/simulasi/admin/packages/:id/discussion
simulasi.patch('/admin/packages/:id/discussion', async (c) => {
  try {
    const packageId = c.req.param('id');
    const { discussionOpen } = await c.req.json(); // 0 = Tutup, 1 = Buka

    await c.env.DB.prepare(
      'UPDATE packages SET discussion_open = ? WHERE id = ? AND app_type = "simulasi"'
    ).bind(discussionOpen, packageId).run();

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal mengubah status pembahasan', details: err.message }, 500);
  }
});

// 9. Live Monitoring Pengawasan: GET /api/simulasi/admin/sessions/:packageId
simulasi.get('/admin/sessions/:packageId', async (c) => {
  try {
    const packageId = c.req.param('packageId');

    const { results } = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.status, ss.tab_switch_count, ss.started_at, ss.submitted_at, s.nama, s.nomor_wa, p.duration
       FROM simulasi_sessions ss
       JOIN students s ON ss.student_id = s.id
       JOIN packages p ON ss.package_id = p.id
       WHERE ss.package_id = ?
       ORDER BY ss.started_at DESC`
    ).bind(packageId).all();

    const processedResults = [];
    for (let s of results) {
      if (s.status === 'ongoing') {
        s = await checkAndForceSubmit(c.env.DB, s);
      }
      processedResults.push({
        nama: s.nama,
        nomor_wa: s.nomor_wa,
        status: s.status,
        tab_switch_count: s.tab_switch_count,
        started_at: s.started_at,
        submitted_at: s.submitted_at
      });
    }

    return c.json(processedResults, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat log live monitoring', details: err.message }, 500);
  }
});

// 10. Unduh Hasil Nilai Lengkap (Ekspor): GET /api/simulasi/admin/submissions/:packageId
simulasi.get('/admin/submissions/:packageId', async (c) => {
  try {
    const packageId = c.req.param('packageId');

    // Force submit all expired sessions first
    const sessions = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.status, ss.started_at, p.duration
       FROM simulasi_sessions ss
       JOIN packages p ON ss.package_id = p.id
       WHERE ss.package_id = ? AND ss.status = "ongoing"`
    ).bind(packageId).all();

    if (sessions.results && sessions.results.length > 0) {
      for (const s of sessions.results) {
        await checkAndForceSubmit(c.env.DB, s);
      }
    }

    const { results } = await c.env.DB.prepare(
      `SELECT s.nama, s.nomor_wa, s.email, sub.score_mcq, sub.score_essay, sub.answers_json, sub.submitted_at
       FROM simulasi_submissions sub
       JOIN students s ON sub.student_id = s.id
       WHERE sub.package_id = ?
       ORDER BY sub.submitted_at DESC`
    ).bind(packageId).all();

    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal mengekstrak hasil nilai simulasi', details: err.message }, 500);
  }
});

export default simulasi;
