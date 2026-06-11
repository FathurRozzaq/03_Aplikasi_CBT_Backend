import { Hono } from 'hono';

const auth = new Hono();

// POST /api/login
auth.post('/login', async (c) => {
  try {
    const { nomorWa, token } = await c.req.json();

    if (!nomorWa || !token) {
      return c.json({ error: 'Nomor WhatsApp dan Token harus diisi' }, 400);
    }

    // Query D1 Database
    const student = await c.env.DB.prepare(
      'SELECT id, nama, nomor_wa, email, token, tier, role, assigned_packages FROM students WHERE nomor_wa = ? AND token = ?'
    ).bind(nomorWa, token).first();

    if (!student) {
      return c.json({ error: 'Nomor WhatsApp atau Token tidak valid' }, 401);
    }

    // Parse assigned packages if it is a JSON string
    let assignedPackages = [];
    try {
      assignedPackages = JSON.parse(student.assigned_packages || '[]');
    } catch (e) {
      assignedPackages = [];
    }

    return c.json({
      success: true,
      user: {
        id: student.id,
        nama: student.nama,
        nomorWa: student.nomor_wa,
        email: student.email,
        token: student.token,
        tier: student.tier || 'free',
        role: student.role || 'student',
        assignedPackages
      }
    }, 200);

  } catch (err) {
    return c.json({ error: 'Internal Server Error', details: err.message }, 500);
  }
});

export default auth;
