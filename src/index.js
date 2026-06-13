import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth.js';
import simulasi from './routes/simulasi.js';

const app = new Hono();

// Middleware CORS untuk melayani request dari frontend Tryout, Simulasi, dan Localhost
app.use('*', cors({
  origin: (origin) => {
    // Izinkan subdomain um-dipo.my.id dan localhost
    if (
      !origin || 
      origin.endsWith('.um-dipo.my.id') || 
      origin === 'https://um-dipo.my.id' || 
      origin.includes('localhost') || 
      origin.includes('127.0.0.1')
    ) {
      return origin;
    }
    return 'https://simulasi.um-dipo.my.id';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Date'],
  maxAge: 600,
  credentials: true,
}));

// Registrasi Route API
app.route('/api', auth);
app.route('/api/simulasi', simulasi);

// Endpoint Tes Koneksi / Health Check
app.get('/', (c) => c.text('UMDipo Shared CBT Backend running successfully on Cloudflare Edge.'));

export default app;
