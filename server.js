const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'novel.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT DEFAULT '',
    published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    heading TEXT DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    music_url TEXT DEFAULT '',
    fade_ms INTEGER NOT NULL DEFAULT 1800,
    UNIQUE(chapter_id, position)
  );
`);

const count = db.prepare('SELECT COUNT(*) AS count FROM chapters').get().count;
if (count === 0) {
  const insertChapter = db.prepare(`INSERT INTO chapters(number,title,slug,summary,published) VALUES (?,?,?,?,1)`);
  const chapter = insertChapter.run(1, 'Пробная глава', 'probnaya-glava', 'Пример структуры главы и фоновой музыки.');
  const insertSection = db.prepare(`INSERT INTO sections(chapter_id,position,heading,body,music_url,fade_ms) VALUES (?,?,?,?,?,?)`);
  insertSection.run(chapter.lastInsertRowid, 1, 'Начало', 'Это пример первого фрагмента текста. Замените его в админке на вашу сцену.', '', 1800);
  insertSection.run(chapter.lastInsertRowid, 2, 'Поворот', 'Добавьте MP3/OGG-файл и он начнёт играть с этого фрагмента. При переходе к следующему фрагменту проигрывание будет плавно сменяться.', '', 2200);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(cookieSession({
  name: 'novel_admin',
  keys: [process.env.SESSION_SECRET || 'change-me-in-production'],
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${safe}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['audio/mpeg','audio/ogg','audio/wav','audio/x-wav','audio/mp4','audio/aac','audio/webm'].includes(file.mimetype);
    cb(ok ? null : new Error('Разрешены только аудиофайлы MP3, OGG, WAV, M4A/AAC или WEBM.'), ok);
  }
});

function slugify(value) {
  return String(value).trim().toLowerCase()
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80) || `chapter-${Date.now()}`;
}
function adminOnly(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect('/admin/login');
}
function getChapters(publishedOnly = false) {
  const where = publishedOnly ? 'WHERE published=1' : '';
  return db.prepare(`SELECT * FROM chapters ${where} ORDER BY number ASC`).all();
}
function getChapter(idOrSlug, includeUnpublished = false) {
  const chapter = db.prepare(`SELECT * FROM chapters WHERE ${/^\d+$/.test(String(idOrSlug)) ? 'id=?' : 'slug=?'} ${includeUnpublished ? '' : 'AND published=1'}`).get(idOrSlug);
  if (!chapter) return null;
  chapter.sections = db.prepare('SELECT * FROM sections WHERE chapter_id=? ORDER BY position ASC').all(chapter.id);
  return chapter;
}

app.get('/', (_req, res) => {
  res.render('index', { chapters: getChapters(true) });
});
app.get('/chapter/:slug', (req, res) => {
  const chapter = getChapter(req.params.slug);
  if (!chapter) return res.status(404).render('404');
  res.render('chapter', { chapter });
});
app.get('/admin/login', (req, res) => res.render('login', { error: null }));
app.post('/admin/login', (req, res) => {
  const password = process.env.ADMIN_PASSWORD || 'change-me';
  const provided = Buffer.from(String(req.body.password || ''));
  const expected = Buffer.from(password);
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('login', { error: 'Неверный пароль.' });
});
app.post('/admin/logout', (req, res) => { req.session = null; res.redirect('/'); });

app.get('/admin', adminOnly, (_req, res) => {
  res.render('admin', { chapters: getChapters(false) });
});
app.get('/admin/chapter/new', adminOnly, (_req, res) => {
  res.render('chapter-edit', { chapter: null, saved: false });
});
app.get('/admin/chapter/:id/edit', adminOnly, (req, res) => {
  const chapter = getChapter(req.params.id, true);
  if (!chapter) return res.status(404).render('404');
  res.render('chapter-edit', { chapter, saved: req.query.saved === '1' });
});
app.post('/admin/chapter/save', adminOnly, (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const number = Number(req.body.number);
  const title = String(req.body.title || '').trim();
  const summary = String(req.body.summary || '').trim();
  const published = req.body.published === 'on' ? 1 : 0;
  if (!title || !Number.isInteger(number) || number < 1) return res.status(400).send('Нужны корректные номер и название главы.');

  let chapterId;
  if (id) {
    const old = db.prepare('SELECT slug FROM chapters WHERE id=?').get(id);
    if (!old) return res.status(404).send('Глава не найдена');
    const slug = slugify(title);
    db.prepare(`UPDATE chapters SET number=?,title=?,slug=?,summary=?,published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(number,title,slug,summary,published,id);
    chapterId = id;
  } else {
    const slug = slugify(title);
    const result = db.prepare(`INSERT INTO chapters(number,title,slug,summary,published) VALUES (?,?,?,?,?)`).run(number,title,slug,summary,published);
    chapterId = result.lastInsertRowid;
  }

  db.prepare('DELETE FROM sections WHERE chapter_id=?').run(chapterId);
  const sections = Array.isArray(req.body.section_heading) ? req.body.section_heading : [req.body.section_heading].filter(Boolean);
  const bodies = Array.isArray(req.body.section_body) ? req.body.section_body : [req.body.section_body].filter(Boolean);
  const musics = Array.isArray(req.body.section_music) ? req.body.section_music : [req.body.section_music].filter(Boolean);
  const fades = Array.isArray(req.body.section_fade) ? req.body.section_fade : [req.body.section_fade].filter(Boolean);
  const insert = db.prepare(`INSERT INTO sections(chapter_id,position,heading,body,music_url,fade_ms) VALUES (?,?,?,?,?,?)`);
  for (let i = 0; i < bodies.length; i++) {
    insert.run(chapterId, i + 1, String(sections[i] || '').trim(), String(bodies[i] || ''), String(musics[i] || '').trim(), Math.max(300, Math.min(8000, Number(fades[i] || 1800))));
  }
  res.redirect(`/admin/chapter/${chapterId}/edit?saved=1`);
});
app.post('/admin/chapter/:id/delete', adminOnly, (req, res) => {
  db.prepare('DELETE FROM chapters WHERE id=?').run(Number(req.params.id));
  res.redirect('/admin');
});
app.post('/admin/upload', adminOnly, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен.' });
  res.json({ url: `/media/${req.file.filename}`, name: req.file.originalname });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Ошибка сервера.' });
});

app.listen(PORT, () => console.log(`Novel site running on :${PORT}`));
