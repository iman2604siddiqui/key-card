import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { classifySensitive } from './lib/classification.js';
import { geminiAnswer } from './lib/gemini.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const storageDir = path.resolve(process.env.STORAGE_DIR || './storage');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const allowedRoles = new Set(['employee', 'hr_admin', 'it_support']);
if (process.env.NODE_ENV === 'production' && (!process.env.DATABASE_URL || !process.env.JWT_SECRET || process.env.JWT_SECRET === 'development-only-secret')) throw new Error('DATABASE_URL and a production JWT_SECRET are required');

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

const requestCounts = new Map();
function rateLimit({ windowMs = 60000, max = 30 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = requestCounts.get(key);
    if (!entry || now - entry.startedAt > windowMs) requestCounts.set(key, { startedAt: now, count: 1 });
    else if (++entry.count > max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    next();
  };
}

app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT current_database() AS database, now() AS server_time');
    res.json({ status: 'ok', database: 'connected', ...rows[0] });
  } catch (error) {
    res.status(503).json({ status: 'degraded', database: 'unavailable', error: error.code || 'connection_failed' });
  }
});

function tokenFor(user) { return jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.full_name, team: user.team }, process.env.JWT_SECRET || 'development-only-secret', { expiresIn: '8h' }); }
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  try { req.user = jwt.verify(header.replace(/^Bearer\s+/i, ''), process.env.JWT_SECRET || 'development-only-secret'); next(); }
  catch { res.status(401).json({ error: 'Authentication required' }); }
}
function requireRole(...roles) { return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' }); }
function splitChunks(text, size = 850) { return text.replace(/\s+/g, ' ').trim().match(new RegExp(`.{1,${size}}(?:\\s|$)`, 'g')) || []; }
async function processDocument(versionId, buffer, mimeType) {
  let text = '';
  if (mimeType === 'application/pdf') text = (await pdfParse(buffer)).text;
  else text = buffer.toString('utf8');
  const chunks = splitChunks(text);
  await pool.query('UPDATE document_versions SET extracted_text=$1 WHERE id=$2', [text, versionId]);
  for (const [index, content] of chunks.entries()) await pool.query('INSERT INTO document_chunks(version_id, chunk_index, content) VALUES($1,$2,$3)', [versionId, index, content]);
  return chunks.length;
}
async function retrieve(question, category) {
  const result = await pool.query(`SELECT c.id, c.content, d.title, d.category, ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS score
    FROM document_chunks c JOIN document_versions v ON v.id=c.version_id JOIN documents d ON d.id=v.document_id
    WHERE d.active=true AND ($2='all' OR d.category=$2) AND c.search_vector @@ plainto_tsquery('english', $1)
    ORDER BY score DESC LIMIT 4`, [question, category || 'all']);
  return result.rows;
}
function deterministicAnswer(question, rows) {
  if (!rows.length || Number(rows[0].score) < 0.02) return null;
  return { answer: rows[0].content.length > 420 ? `${rows[0].content.slice(0, 417)}...` : rows[0].content, confidence: Math.min(.94, Math.max(.75, Number(rows[0].score) + .75)), source: [...new Set(rows.map(row => row.title))].join(', ') };
}

app.post('/api/auth/register', rateLimit({ max: 10 }), async (req, res) => {
  const { email, password, fullName, team } = req.body;
  if (!email || !password || !fullName || password.length < 8) return res.status(400).json({ error: 'Email, full name, and an 8-character password are required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO users(email,password_hash,full_name,role,team) VALUES($1,$2,$3,$4,$5) RETURNING id,email,full_name,role,team', [email.toLowerCase(), hash, fullName, 'employee', team || null]);
    res.status(201).json({ user: rows[0], token: tokenFor(rows[0]) });
  } catch (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'Email already exists' : 'Registration failed' }); }
});
app.post('/api/auth/login', rateLimit({ max: 10 }), async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return res.status(401).json({ error: 'Invalid email or password' });
  const { password_hash, ...user } = rows[0]; res.json({ user, token: tokenFor(user) });
});
app.post('/api/auth/password-reset/request', rateLimit({ max: 5 }), async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const response = { message: 'If an account exists, reset instructions have been created.' };
  const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (rows[0]) {
    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query('INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'30 minutes\')', [rows[0].id, tokenHash]);
    if (process.env.NODE_ENV !== 'production') response.developmentToken = token;
  }
  res.json(response);
});
app.post('/api/auth/password-reset/confirm', rateLimit({ max: 10 }), async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) return res.status(400).json({ error: 'A reset token and an 8-character password are required' });
  const tokenHash = createHash('sha256').update(String(token)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id,user_id FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL FOR UPDATE', [tokenHash]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Reset token is invalid or expired' }); }
    const hash = await bcrypt.hash(password, 12);
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
    await client.query('UPDATE password_reset_tokens SET used_at=now() WHERE id=$1', [rows[0].id]);
    await client.query('COMMIT');
    res.json({ message: 'Password updated successfully' });
  } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Password reset failed' }); }
  finally { client.release(); }
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/documents', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT d.id,d.title,d.category,d.owner,d.classification,d.active,d.created_at,v.id AS version_id,v.version,v.effective_date,v.original_filename,v.mime_type,v.byte_size
    FROM documents d LEFT JOIN LATERAL (SELECT * FROM document_versions WHERE document_id=d.id ORDER BY created_at DESC LIMIT 1) v ON true WHERE d.active=true ORDER BY d.created_at DESC`);
  res.json({ documents: rows });
});
app.post('/api/documents', auth, requireRole('hr_admin', 'it_support'), upload.single('file'), async (req, res) => {
  if (!req.file || !req.body.title || !req.body.category || !req.body.version) return res.status(400).json({ error: 'title, category, version, and file are required' });
  const documentId = randomUUID(); const versionId = randomUUID(); const storageKey = `${documentId}/${versionId}-${path.basename(req.file.originalname)}`;
  await fs.mkdir(path.join(storageDir, documentId), { recursive: true }); await fs.writeFile(path.join(storageDir, storageKey.split('/').slice(1).join('/')), req.file.buffer);
  await pool.query('INSERT INTO documents(id,title,category,owner,classification) VALUES($1,$2,$3,$4,$5)', [documentId, req.body.title, req.body.category, req.user.name, req.body.classification || 'Internal']);
  await pool.query('INSERT INTO document_versions(id,document_id,version,effective_date,storage_key,original_filename,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [versionId, documentId, req.body.version, req.body.effectiveDate || null, storageKey, req.file.originalname, req.file.mimetype, req.file.size]);
  const chunkCount = await processDocument(versionId, req.file.buffer, req.file.mimetype);
  res.status(201).json({ id: documentId, versionId, chunkCount });
});
app.post('/api/documents/:id/archive', auth, requireRole('hr_admin', 'it_support'), async (req, res) => { await pool.query('UPDATE documents SET active=false WHERE id=$1', [req.params.id]); res.status(204).end(); });
app.delete('/api/documents/:id', auth, requireRole('hr_admin'), async (req, res) => { await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]); res.status(204).end(); });
app.get('/api/documents/:id/download', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT v.storage_key,v.original_filename,v.mime_type FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.id=$1 AND d.active=true ORDER BY v.created_at DESC LIMIT 1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
  const file = path.join(storageDir, rows[0].storage_key); res.download(file, rows[0].original_filename, { headers: { 'Content-Type': rows[0].mime_type } });
});

app.post('/api/conversations', auth, async (req, res) => { const { rows } = await pool.query('INSERT INTO conversations(user_id) VALUES($1) RETURNING id,created_at', [req.user.id]); res.status(201).json({ conversation: rows[0] }); });
app.get('/api/conversations', auth, async (req, res) => { const { rows } = await pool.query('SELECT * FROM conversations WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json({ conversations: rows }); });
app.get('/api/conversations/:id/messages', auth, async (req, res) => { const { rows } = await pool.query(`SELECT m.*, COALESCE(json_agg(json_build_object('title',d.title,'score',s.relevance_score)) FILTER (WHERE s.id IS NOT NULL), '[]') sources FROM messages m LEFT JOIN sources s ON s.message_id=m.id LEFT JOIN document_chunks c ON c.id=s.chunk_id LEFT JOIN document_versions v ON v.id=c.version_id LEFT JOIN documents d ON d.id=v.document_id JOIN conversations co ON co.id=m.conversation_id WHERE m.conversation_id=$1 AND co.user_id=$2 GROUP BY m.id ORDER BY m.created_at`, [req.params.id, req.user.id]); res.json({ messages: rows }); });
app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  const question = String(req.body.question || '').trim(); if (!question) return res.status(400).json({ error: 'Question is required' });
  const own = await pool.query('SELECT id FROM conversations WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); if (!own.rows[0]) return res.status(404).json({ error: 'Conversation not found' });
  const userMessage = await pool.query('INSERT INTO messages(conversation_id,role,content) VALUES($1,\'user\',$2) RETURNING id', [req.params.id, question]);
  const sensitive = classifySensitive(question); let decision = sensitive ? { escalate: true, reason: sensitive.reason, category: sensitive.category, confidence: null } : null;
  const rows = decision ? [] : await retrieve(question, req.user.role === 'it_support' ? 'it' : 'all');
  let grounded = null;
  if (!decision) {
    try { grounded = await geminiAnswer(question, rows); }
    catch (error) { console.warn(`Gemini unavailable; using extractive fallback: ${error.message}`); }
    grounded ||= deterministicAnswer(question, rows);
  }
  if (!decision && !grounded) decision = { escalate: true, reason: rows.length ? 'low_confidence' : 'undocumented', category: 'other', confidence: rows.length ? Number(rows[0].score) : 0 };
  const assistant = decision ? { answer: null, confidence: decision.confidence, category: decision.category, escalate: true, escalate_reason: decision.reason, source: null } : { answer: grounded.answer, confidence: grounded.confidence, category: rows[0].category, escalate: false, escalate_reason: null, source: grounded.source };
  const assistantMessage = await pool.query('INSERT INTO messages(conversation_id,role,content,answerable,confidence) VALUES($1,\'assistant\',$2,$3,$4) RETURNING id,created_at', [req.params.id, assistant.answer || `Escalated: ${assistant.escalate_reason}`, !assistant.escalate, assistant.confidence]);
  for (const row of rows) await pool.query('INSERT INTO sources(message_id,chunk_id,relevance_score) VALUES($1,$2,$3)', [assistantMessage.rows[0].id, row.id, row.score]);
  if (assistant.escalate) await pool.query('INSERT INTO escalations(message_id,reason,routed_to) VALUES($1,$2,$3)', [assistantMessage.rows[0].id, assistant.escalate_reason, req.user.role === 'it_support' ? 'it_support' : 'hr_admin']);
  res.json({ result: assistant, messageId: assistantMessage.rows[0].id });
});
app.get('/api/escalations', auth, requireRole('hr_admin', 'it_support'), async (req, res) => { const filter = req.user.role === 'it_support' ? 'AND e.routed_to=\'it_support\'' : ''; const { rows } = await pool.query(`SELECT e.*,m.content AS question,u.email FROM escalations e JOIN messages m ON m.id=e.message_id JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=c.user_id WHERE 1=1 ${filter} ORDER BY e.created_at DESC`); res.json({ escalations: rows }); });

await fs.mkdir(storageDir, { recursive: true });
app.listen(port, () => console.log(`Keycard API listening on http://localhost:${port}`));
