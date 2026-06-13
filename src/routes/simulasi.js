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
    const scheduleId = session.schedule_id || `legacy_${packageId}`;

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

    const submissionId = `${studentId}_${scheduleId}`;

    await db.batch([
      db.prepare(
        'UPDATE simulasi_sessions SET status = "submitted", submitted_at = ? WHERE id = ?'
      ).bind(now, sessionId),
      db.prepare(
        `INSERT OR REPLACE INTO simulasi_submissions 
         (id, student_id, package_id, schedule_id, score_mcq, score_essay, answers_json, analysis_json, submitted_at) 
         VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`
      ).bind(
        submissionId,
        studentId,
        packageId,
        scheduleId,
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

// 0. Ambil Daftar Sesi Ujian Siswa (Aman): GET /api/simulasi/packages/:studentId
simulasi.get('/packages/:studentId', async (c) => {
  try {
    const studentId = c.req.param('studentId');

    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.package_id, s.title, s.scheduled_start, s.discussion_open, s.participants_json,
              p.subject, p.duration, p.questions_count, p.title AS package_title,
              ss.status AS session_status, ss.id AS session_id,
              sub.score_mcq
       FROM simulasi_schedules s
       JOIN packages p ON s.package_id = p.id
       LEFT JOIN simulasi_sessions ss ON s.id = ss.schedule_id AND ss.student_id = ?
       LEFT JOIN simulasi_submissions sub ON sub.schedule_id = s.id AND sub.student_id = ?
       WHERE p.is_active = 1`
    ).bind(studentId, studentId).all();

    const filteredResults = results.filter(sched => {
      try {
        const participants = JSON.parse(sched.participants_json || '[]');
        return participants.includes(studentId);
      } catch (e) {
        return false;
      }
    }).map(sched => {
      const { participants_json, ...rest } = sched;
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
    const { studentId, scheduleId } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!studentId || !scheduleId) {
      return c.json({ error: 'Student ID dan Schedule ID wajib diisi' }, 400);
    }

    // A. Ambil jadwal ujian dari simulasi_schedules
    const schedule = await c.env.DB.prepare(
      'SELECT package_id, scheduled_start, participants_json FROM simulasi_schedules WHERE id = ?'
    ).bind(scheduleId).first();

    if (!schedule) {
      return c.json({ error: 'Jadwal sesi simulasi tidak ditemukan' }, 404);
    }

    // B. Verifikasi whitelist peserta
    try {
      const participants = JSON.parse(schedule.participants_json || '[]');
      if (!participants.includes(studentId)) {
        return c.json({ error: 'Akses ditolak. Anda tidak terdaftar sebagai peserta sesi ini.' }, 403);
      }
    } catch (e) {
      return c.json({ error: 'Gagal memvalidasi daftar peserta.' }, 500);
    }

    // C. Verifikasi rentang waktu pengerjaan
    if (schedule.scheduled_start && now < schedule.scheduled_start) {
      return c.json({ error: 'Ujian simulasi belum dimulai' }, 400);
    }

    // D. Cek apakah sesi sudah pernah dibuat
    const existingSession = await c.env.DB.prepare(
      'SELECT id, status FROM simulasi_sessions WHERE student_id = ? AND schedule_id = ?'
    ).bind(studentId, scheduleId).first();

    if (existingSession) {
      if (existingSession.status === 'submitted') {
        return c.json({ error: 'Anda sudah pernah menyelesaikan paket simulasi ini. Batas pengerjaan 1x.' }, 403);
      }
      // Jika masih ongoing, kembalikan sesi yang ada (reload recovery)
      return c.json({ sessionId: existingSession.id, status: 'ongoing' }, 200);
    }

    // E. Buat sesi baru
    const sessionId = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO simulasi_sessions (id, student_id, package_id, schedule_id, status, started_at) VALUES (?, ?, ?, ?, "ongoing", ?)'
    ).bind(sessionId, studentId, schedule.package_id, scheduleId, now).run();

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
      `SELECT ss.id, ss.student_id, ss.package_id, ss.schedule_id, ss.status, ss.tab_switch_count, ss.started_at, p.duration, p.title AS package_title, s.title AS schedule_title
       FROM simulasi_sessions ss
       JOIN packages p ON ss.package_id = p.id
       LEFT JOIN simulasi_schedules s ON ss.schedule_id = s.id
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

// 2b. Ambil Soal Ujian (Hanya jika sesi aktif & Sembunyikan Kunci Jawaban): GET /api/simulasi/questions/:scheduleId/:sessionId
simulasi.get('/questions/:scheduleId/:sessionId', async (c) => {
  try {
    const scheduleId = c.req.param('scheduleId');
    const sessionId = c.req.param('sessionId');

    let session = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.schedule_id, ss.status, ss.started_at, p.duration 
       FROM simulasi_sessions ss 
       JOIN packages p ON ss.package_id = p.id 
       WHERE ss.id = ? AND ss.schedule_id = ?`
    ).bind(sessionId, scheduleId).first();

    if (!session) {
      return c.json({ error: 'Sesi tidak ditemukan' }, 404);
    }

    session = await checkAndForceSubmit(c.env.DB, session);

    if (session.status !== 'ongoing') {
      return c.json({ error: 'Akses ditolak. Sesi tidak aktif atau sudah selesai dikerjakan.' }, 403);
    }

    const schedule = await c.env.DB.prepare(
      `SELECT s.id AS schedule_id, s.title AS schedule_title, p.id AS package_id, p.title AS package_title, p.subject, p.duration, p.questions_json
       FROM simulasi_schedules s
       JOIN packages p ON s.package_id = p.id
       WHERE s.id = ?`
    ).bind(scheduleId).first();

    if (!schedule) {
      return c.json({ error: 'Jadwal simulasi tidak ditemukan' }, 404);
    }

    const questions = JSON.parse(schedule.questions_json || '[]');

    // Sembunyikan correct_answer dan explanation saat pengerjaan agar aman dari inspect element
    const clientQuestions = questions.map((q) => {
      const { correct_answer, explanation, ...rest } = q;
      return rest;
    });

    return c.json({
      success: true,
      id: schedule.schedule_id,
      title: schedule.schedule_title,
      package_id: schedule.package_id,
      package_title: schedule.package_title,
      subject: schedule.subject,
      duration: schedule.duration,
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
    const { studentId, scheduleId, sessionId, answers } = await c.req.json();
    const now = Math.floor(Date.now() / 1000);

    if (!studentId || !scheduleId || !sessionId || !answers) {
      return c.json({ error: 'Data pengerjaan tidak lengkap' }, 400);
    }

    // A. Ambil jadwal dan paket soal terkait
    const schedule = await c.env.DB.prepare(
      `SELECT s.package_id, p.questions_json
       FROM simulasi_schedules s
       JOIN packages p ON s.package_id = p.id
       WHERE s.id = ?`
    ).bind(scheduleId).first();

    if (!schedule) {
      return c.json({ error: 'Jadwal simulasi tidak ditemukan' }, 404);
    }

    const questions = JSON.parse(schedule.questions_json || '[]');
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
    const submissionId = `${studentId}_${scheduleId}`;

    // C. Simpan ke Database (Batch Transaction)
    await c.env.DB.batch([
      // Update status sesi
      c.env.DB.prepare(
        'UPDATE simulasi_sessions SET status = "submitted", submitted_at = ? WHERE id = ?'
      ).bind(now, sessionId),
      // Simpan berkas hasil ujian
      c.env.DB.prepare(
        `INSERT OR REPLACE INTO simulasi_submissions 
         (id, student_id, package_id, schedule_id, score_mcq, score_essay, answers_json, analysis_json, submitted_at) 
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      ).bind(
        submissionId,
        studentId,
        schedule.package_id,
        scheduleId,
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

// 4b. Ambil Hasil Ujian Siswa (Aman): GET /api/simulasi/submission/:scheduleId/:studentId
simulasi.get('/submission/:scheduleId/:studentId', async (c) => {
  try {
    const scheduleId = c.req.param('scheduleId');
    const studentId = c.req.param('studentId');

    const submission = await c.env.DB.prepare(
      `SELECT sub.score_mcq, sub.score_essay, sub.answers_json, sub.analysis_json, sub.submitted_at,
              ss.id AS session_id
       FROM simulasi_submissions sub
       JOIN simulasi_sessions ss ON ss.schedule_id = sub.schedule_id AND ss.student_id = sub.student_id
       WHERE sub.student_id = ? AND sub.schedule_id = ?`
    ).bind(studentId, scheduleId).first();

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

// 4c. Ambil Pembahasan & Kunci Soal (Aman & Terkunci): GET /api/simulasi/discussion/:scheduleId/:sessionId
simulasi.get('/discussion/:scheduleId/:sessionId', async (c) => {
  try {
    const scheduleId = c.req.param('scheduleId');
    const sessionId = c.req.param('sessionId');

    // A. Validasi Sesi: Pastikan sesi sudah submitted
    const session = await c.env.DB.prepare(
      'SELECT status FROM simulasi_sessions WHERE id = ? AND schedule_id = ?'
    ).bind(sessionId, scheduleId).first();

    if (!session || session.status !== 'submitted') {
      return c.json({ error: 'Akses ditolak. Sesi belum dikirim/selesai.' }, 403);
    }

    // B. Validasi Pembahasan: Pastikan sudah dibuka oleh admin
    const schedule = await c.env.DB.prepare(
      `SELECT s.id AS schedule_id, s.title AS schedule_title, s.discussion_open, p.id AS package_id, p.title AS package_title, p.subject, p.questions_json
       FROM simulasi_schedules s
       JOIN packages p ON s.package_id = p.id
       WHERE s.id = ?`
    ).bind(scheduleId).first();

    if (!schedule) {
      return c.json({ error: 'Jadwal simulasi tidak ditemukan' }, 404);
    }

    if (schedule.discussion_open !== 1 && schedule.discussion_open !== true) {
      return c.json({ error: 'Pembahasan belum dibuka oleh admin.', discussionOpen: false }, 403);
    }

    const questions = JSON.parse(schedule.questions_json || '[]');

    return c.json({
      success: true,
      id: schedule.schedule_id,
      title: schedule.schedule_title,
      package_id: schedule.package_id,
      package_title: schedule.package_title,
      subject: schedule.subject,
      questions
    }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal memuat pembahasan', details: err.message }, 500);
  }
});

// 5. Proxy AI Chat Isa (Gemini): POST /api/simulasi/chat-isa
simulasi.post('/chat-isa', async (c) => {
  try {
    const { studentId, sessionId, message, history } = await c.req.json();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

    if (!studentId || !sessionId || !message) {
      return c.json({ error: 'Payload tidak lengkap' }, 400);
    }

    // A. Validasi Sesi: Pastikan user sudah menyelesaikan ujian
    const session = await c.env.DB.prepare(
      'SELECT status FROM simulasi_sessions WHERE id = ?'
    ).bind(sessionId).first();

    if (!session || session.status !== 'submitted') {
      return c.json({ error: 'AI Chat pembahasan hanya terbuka setelah ujian kamu dikirimkan' }, 403);
    }

    // B. Cek Quota limit harian global siswa hari ini (50/hari)
    const usageQuery = await c.env.DB.prepare(
      'SELECT SUM(daily_count) AS total FROM simulasi_chat_histories WHERE student_id = ? AND last_reset_date = ?'
    ).bind(studentId, today).first();
    const totalToday = usageQuery?.total || 0;

    if (totalToday >= 50) {
      return c.json({ error: 'Kuota chat kamu hari ini telah habis. Kuota akan direset besok pukul 00:00 WIB.' }, 429);
    }

    // Ambil riwayat khusus sesi terkait untuk melacak daily_count
    let chatHistory = await c.env.DB.prepare(
      'SELECT id, daily_count, last_reset_date FROM simulasi_chat_histories WHERE student_id = ? AND session_id = ?'
    ).bind(studentId, sessionId).first();

    // C. Panggil Gemini API Pro via HTTP Fetch
    const systemInstructionText = 'Kamu adalah Isa, seorang tutor pendamping belajar yang santai, bersahabat, dan suportif untuk membantu peserta memahami pembahasan soal ujian. Jangan sebutkan kata "Gemini", "Google", "AI", atau "Asisten Virtual" di dalam penjelasanmu. Cukup panggil dirimu sebagai "Isa". Gunakan bahasa Indonesia yang santai, akrab, ramah, dan tidak formal/kaku (seperti mengobrol dengan teman dekat atau kakak tutor). PENTING: Jangan pernah menggunakan kata "Anda"! Selalu gunakan kata "kamu" untuk menyapa pengguna. Gunakan format Markdown untuk penulisan matematika / rumus jika diperlukan.';
    const geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

    const contents = [
      ...(history || []).map(m => ({
        role: m.sender === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const response = await fetch(geminiEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-goog-api-key': c.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemInstructionText }]
        }
      })
    });

    const data = await response.json();
    const botReply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Maaf, sistem asisten Isa sedang mengalami kendala. Coba beberapa saat lagi.';

    // D. Update daily_count saja di D1 (tanpa update messages_json untuk hemat write)
    if (chatHistory) {
      const newCount = chatHistory.last_reset_date === today ? (chatHistory.daily_count + 1) : 1;
      await c.env.DB.prepare(
        `UPDATE simulasi_chat_histories 
         SET daily_count = ?, last_reset_date = ?, updated_at = ? 
         WHERE id = ?`
      ).bind(newCount, today, Math.floor(Date.now() / 1000), chatHistory.id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO simulasi_chat_histories 
         (student_id, session_id, messages_json, daily_count, last_reset_date, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(studentId, sessionId, '[]', 1, today, Math.floor(Date.now() / 1000)).run();
    }

    return c.json({ reply: botReply }, 200);

  } catch (err) {
    return c.json({ error: 'Gagal menghubungi asisten virtual Isa', details: err.message }, 500);
  }
});

// 5b. Simpan/Sinkronisasi Riwayat Chat (Batch): POST /api/simulasi/chat-save
simulasi.post('/chat-save', async (c) => {
  try {
    const { studentId, sessionId, messages } = await c.req.json();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

    if (!studentId || !sessionId || !messages) {
      return c.json({ error: 'Payload tidak lengkap' }, 400);
    }

    let chatHistory = await c.env.DB.prepare(
      'SELECT id FROM simulasi_chat_histories WHERE student_id = ? AND session_id = ?'
    ).bind(studentId, sessionId).first();

    if (chatHistory) {
      await c.env.DB.prepare(
        `UPDATE simulasi_chat_histories 
         SET messages_json = ?, updated_at = ? 
         WHERE id = ?`
      ).bind(JSON.stringify(messages), Math.floor(Date.now() / 1000), chatHistory.id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO simulasi_chat_histories 
         (student_id, session_id, messages_json, daily_count, last_reset_date, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(studentId, sessionId, JSON.stringify(messages), 0, today, Math.floor(Date.now() / 1000)).run();
    }

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal sinkronisasi chat', details: err.message }, 500);
  }
});

// 5c. Ambil Riwayat Chat (Session-based): GET /api/simulasi/chat-history/:sessionId/:studentId
simulasi.get('/chat-history/:sessionId/:studentId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const studentId = c.req.param('studentId');

    const chatHistory = await c.env.DB.prepare(
      'SELECT messages_json FROM simulasi_chat_histories WHERE student_id = ? AND session_id = ?'
    ).bind(studentId, sessionId).first();

    if (chatHistory && chatHistory.messages_json) {
      return c.json({ messages: JSON.parse(chatHistory.messages_json) }, 200);
    }

    return c.json({ messages: [] }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal mengambil riwayat chat', details: err.message }, 500);
  }
});

// ==========================================
// PORTAL ADMIN (ADMIN PORTAL)
// ==========================================

// 6. Ambil Daftar Paket Simulasi untuk Dropdown: GET /api/simulasi/admin/packages
simulasi.get('/admin/packages', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, title, subject, duration, questions_count, is_active FROM packages WHERE app_type = "simulasi"'
    ).all();
    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat paket soal simulasi', details: err.message }, 500);
  }
});

// 7. Ambil Daftar Jadwal Ujian: GET /api/simulasi/admin/schedules
simulasi.get('/admin/schedules', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.package_id, s.title, s.scheduled_start, s.discussion_open, s.participants_json, s.created_at, p.title AS package_title, p.subject, p.duration
       FROM simulasi_schedules s
       JOIN packages p ON s.package_id = p.id
       ORDER BY s.created_at DESC`
    ).all();
    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memuat daftar jadwal simulasi', details: err.message }, 500);
  }
});

// 8. Buat Jadwal Ujian Baru: POST /api/simulasi/admin/schedules
simulasi.post('/admin/schedules', async (c) => {
  try {
    const { packageId, title, scheduledStart, participants } = await c.req.json();
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO simulasi_schedules (id, package_id, title, scheduled_start, discussion_open, participants_json, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      id,
      packageId,
      title,
      scheduledStart,
      JSON.stringify(participants || []),
      now
    ).run();

    return c.json({ success: true, id }, 201);
  } catch (err) {
    return c.json({ error: 'Gagal membuat jadwal baru', details: err.message }, 500);
  }
});

// 9. Edit Detail/Peserta/Pembahasan Jadwal: PATCH /api/simulasi/admin/schedules/:id
simulasi.patch('/admin/schedules/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const { title, scheduledStart, discussionOpen, participants } = await c.req.json();

    let query = 'UPDATE simulasi_schedules SET ';
    const params = [];
    const updates = [];

    if (title !== undefined) {
      updates.push('title = ?');
      params.push(title);
    }
    if (scheduledStart !== undefined) {
      updates.push('scheduled_start = ?');
      params.push(scheduledStart);
    }
    if (discussionOpen !== undefined) {
      updates.push('discussion_open = ?');
      params.push(discussionOpen);
    }
    if (participants !== undefined) {
      updates.push('participants_json = ?');
      params.push(JSON.stringify(participants));
    }

    if (updates.length === 0) {
      return c.json({ error: 'Tidak ada data untuk diperbarui' }, 400);
    }

    query += updates.join(', ') + ' WHERE id = ?';
    params.push(id);

    await c.env.DB.prepare(query).bind(...params).run();

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal memperbarui jadwal', details: err.message }, 500);
  }
});

// 10. Hapus Jadwal Ujian: DELETE /api/simulasi/admin/schedules/:id
simulasi.delete('/admin/schedules/:id', async (c) => {
  try {
    const scheduleId = c.req.param('id');

    // 1. Ambil daftar session_id yang terikat dengan scheduleId ini untuk menghapus chat_histories
    const sessions = await c.env.DB.prepare(
      'SELECT id FROM simulasi_sessions WHERE schedule_id = ?'
    ).bind(scheduleId).all();
    const sessionIds = (sessions.results || []).map(s => s.id);

    const batchStatements = [];

    // 2. Jika ada sesi, buat statement hapus chat_histories
    if (sessionIds.length > 0) {
      sessionIds.forEach(sid => {
        batchStatements.push(
          c.env.DB.prepare('DELETE FROM simulasi_chat_histories WHERE session_id = ?').bind(sid)
        );
      });
    }

    // 3. Tambahkan statement hapus dari tabel simulasi_sessions
    batchStatements.push(
      c.env.DB.prepare('DELETE FROM simulasi_sessions WHERE schedule_id = ?').bind(scheduleId)
    );

    // 4. Tambahkan statement hapus dari tabel simulasi_submissions
    batchStatements.push(
      c.env.DB.prepare('DELETE FROM simulasi_submissions WHERE schedule_id = ?').bind(scheduleId)
    );

    // 5. Tambahkan statement hapus jadwal dari tabel simulasi_schedules
    batchStatements.push(
      c.env.DB.prepare('DELETE FROM simulasi_schedules WHERE id = ?').bind(scheduleId)
    );

    // Eksekusi batch transaction di D1
    await c.env.DB.batch(batchStatements);

    return c.json({ success: true }, 200);
  } catch (err) {
    return c.json({ error: 'Gagal menghapus jadwal dan data terkait', details: err.message }, 500);
  }
});

// 11. Ambil Daftar Siswa Pro2: GET /api/simulasi/admin/students
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

// 12. Live Monitoring Pengawasan: GET /api/simulasi/admin/sessions/:scheduleId
simulasi.get('/admin/sessions/:scheduleId', async (c) => {
  try {
    const scheduleId = c.req.param('scheduleId');

    const { results } = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.schedule_id, ss.status, ss.tab_switch_count, ss.started_at, ss.submitted_at, s.nama, s.nomor_wa, p.duration
       FROM simulasi_sessions ss
       JOIN students s ON ss.student_id = s.id
       JOIN packages p ON ss.package_id = p.id
       WHERE ss.schedule_id = ?
       ORDER BY ss.started_at DESC`
    ).bind(scheduleId).all();

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

// 13. Unduh Hasil Nilai Lengkap (Ekspor): GET /api/simulasi/admin/submissions/:scheduleId
simulasi.get('/admin/submissions/:scheduleId', async (c) => {
  try {
    const scheduleId = c.req.param('scheduleId');

    // Force submit all expired sessions first
    const sessions = await c.env.DB.prepare(
      `SELECT ss.id, ss.student_id, ss.package_id, ss.schedule_id, ss.status, ss.started_at, p.duration
       FROM simulasi_sessions ss
       JOIN packages p ON ss.package_id = p.id
       WHERE ss.schedule_id = ? AND ss.status = "ongoing"`
    ).bind(scheduleId).all();

    if (sessions.results && sessions.results.length > 0) {
      for (const s of sessions.results) {
        await checkAndForceSubmit(c.env.DB, s);
      }
    }

    const { results } = await c.env.DB.prepare(
      `SELECT s.nama, s.nomor_wa, s.email, sub.score_mcq, sub.score_essay, sub.answers_json, sub.submitted_at
       FROM simulasi_submissions sub
       JOIN students s ON sub.student_id = s.id
       WHERE sub.schedule_id = ?
       ORDER BY sub.submitted_at DESC`
    ).bind(scheduleId).all();

    return c.json(results, 200);
  } catch (err) {
    return c.json({ error: 'Gagal mengekstrak hasil nilai simulasi', details: err.message }, 500);
  }
});

export default simulasi;
