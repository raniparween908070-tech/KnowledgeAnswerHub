import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const SITE_NAME = (process.env.SITE_NAME || 'Knowledge Answer Hub').trim();
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

function resolveGeminiModel() {
  const raw = (process.env.GEMINI_MODEL || '').trim().replace(/^["']|["']$/g, '');
  if (/^(models\/)?gemini-[a-z0-9.-]+$/i.test(raw)) {
    return raw;
  }
  if (raw) {
    console.warn(`[Config Warning] Ignoring invalid GEMINI_MODEL value; falling back to ${DEFAULT_MODEL}.`);
  }
  return DEFAULT_MODEL;
}

const GEMINI_MODEL = resolveGeminiModel();

const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const DATA_DIR = IS_SERVERLESS
  ? path.resolve(os.tmpdir(), 'knowledge-answer-hub-data')
  : path.resolve(__dirname, 'data');
const CONTACT_FILE = path.resolve(DATA_DIR, 'contact-messages.json');

const MAX_QUESTION_LENGTH = 1200;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_TEXT_LENGTH = 4000;

const ALLOWED_SUBJECTS = new Set([
  'General Knowledge',
  'Science',
  'Technology',
  'History',
  'Education',
  'Health',
  'Business',
  'Religion',
  'Other',
]);

const ALLOWED_LANGUAGES = new Set([
  'English',
  'Hindi',
  'Urdu',
  'Spanish',
  'Arabic',
  'French',
  'Bengali',
  'German',
  'Portuguese',
  'Japanese',
]);

const PLACEHOLDER_KEYS = new Set([
  '',
  'PASTE_YOUR_GEMINI_API_KEY_HERE',
  'MY_GEMINI_API_KEY',
  'YOUR_GEMINI_API_KEY',
]);

function getConfiguredApiKey() {
  const raw = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!raw || PLACEHOLDER_KEYS.has(raw)) {
    return null;
  }
  return raw;
}

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }
  // Remove NUL and non-printable control characters while preserving tabs and newlines
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.slice(0, maxLength);
}

function buildSystemInstruction(subject, language) {
  return [
    `You are the educational assistant for ${SITE_NAME}.`,
    `Answer the user's question clearly, accurately, and in simple, approachable ${language}.`,
    `The user selected the subject category: "${subject}". Tailor your explanation and examples to this context when relevant.`,
    `Language requirement: Write the entire response strictly in ${language} (including headings and bullet points).`,
    `Formatting guidelines:`,
    `- Use clean Markdown headings (## and ###), short readable paragraphs, and bulleted or numbered lists where helpful.`,
    `- Explain complex ideas in everyday language first before introducing technical terms.`,
    `- Keep answers thorough yet concise (typically 150–450 words unless deeper explanation is needed).`,
    `- Do not fabricate sources, statistics, or citations. If a question asks about recent events or uncertain facts, state limitations clearly.`,
    `- For Health, Business, legal, or financial topics, provide general educational information only and remind the reader to consult a qualified professional for personal decisions.`,
  ].join('\n');
}

// Serialized write queue so concurrent contact submissions never corrupt JSON storage
let writeQueue = Promise.resolve();

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function saveContactMessage(entry) {
  const run = async () => {
    await ensureDataDir();
    if (!CONTACT_FILE.startsWith(DATA_DIR + path.sep)) {
      throw new Error('Invalid storage path configuration.');
    }

    let messages = [];
    try {
      const existing = await fs.readFile(CONTACT_FILE, 'utf8');
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) {
        messages = parsed;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw err;
      }
    }

    messages.push(entry);
    const tempFile = path.resolve(DATA_DIR, `contact-messages.${crypto.randomUUID()}.tmp`);
    if (!tempFile.startsWith(DATA_DIR + path.sep)) {
      throw new Error('Invalid temporary storage path.');
    }
    await fs.writeFile(tempFile, JSON.stringify(messages, null, 2), 'utf8');
    await fs.rename(tempFile, CONTACT_FILE);
  };

  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => {});
  return next;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
        frameAncestors: [
          "'self'",
          'https://*.google.com',
          'https://*.googleusercontent.com',
          'https://aistudio.google.com',
          'https://*.aistudio.google.com',
        ],
      },
    },
    frameguard: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })
);

app.use(express.json({ limit: '32kb' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload is too large.' });
  }
  return next(err);
});

function getClientIpKey(req) {
  const nfIp = req.headers['x-nf-client-connection-ip'];
  if (typeof nfIp === 'string' && nfIp.trim()) {
    return nfIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }
  return 'unknown-client';
}

const askLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  validate: { xForwardedForHeader: false, ip: false, keyGeneratorIpFallback: false },
  message: {
    error: 'Too many questions submitted from this connection. Please wait a few minutes before asking again.',
  },
});

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  validate: { xForwardedForHeader: false, ip: false, keyGeneratorIpFallback: false },
  message: {
    error: 'Too many contact messages sent recently. Please try again in 15 minutes.',
  },
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    siteName: SITE_NAME,
    configured: Boolean(getConfiguredApiKey()),
  });
});

app.post('/api/ask', askLimiter, async (req, res) => {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return res.status(503).json({
      error:
        'The AI service is not configured yet. Please add a valid GEMINI_API_KEY in your .env file (copied from .env.example) and restart the server.',
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const question = sanitizeText(body.question, MAX_QUESTION_LENGTH + 1);

  if (!question) {
    return res.status(400).json({ error: 'Please enter a question before submitting.' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({
      error: `Your question is too long. Please keep it under ${MAX_QUESTION_LENGTH} characters.`,
    });
  }

  const rawSubject = typeof body.subject === 'string' ? body.subject.trim() : 'General Knowledge';
  const subject = ALLOWED_SUBJECTS.has(rawSubject) ? rawSubject : 'General Knowledge';

  const rawLanguage = typeof body.language === 'string' ? body.language.trim() : 'English';
  const language = ALLOWED_LANGUAGES.has(rawLanguage) ? rawLanguage : 'English';

  const contents = [];
  if (Array.isArray(body.history)) {
    const trimmedHistory = body.history.slice(-MAX_HISTORY_TURNS);
    for (const turn of trimmedHistory) {
      if (!turn || typeof turn !== 'object') {
        continue;
      }
      const role = turn.role === 'model' ? 'model' : turn.role === 'user' ? 'user' : null;
      const text = sanitizeText(turn.text, MAX_HISTORY_TEXT_LENGTH);
      if (role && text) {
        contents.push({
          role,
          parts: [{ text }],
        });
      }
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: question }],
  });

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    async function callGeminiWithRetry() {
      const maxAttempts = 3;
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents,
            config: {
              systemInstruction: buildSystemInstruction(subject, language),
            },
          });
        } catch (err) {
          lastError = err;
          const errStatus = err && typeof err.status === 'number' ? err.status : 0;
          const isTransient = errStatus === 500 || errStatus === 502 || errStatus === 503 || errStatus === 504 || errStatus === 0;
          if (!isTransient || attempt === maxAttempts) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 600));
        }
      }
      throw lastError;
    }

    const response = await callGeminiWithRetry();

    const answer = typeof response.text === 'string' ? response.text.trim() : '';
    if (!answer) {
      return res.status(502).json({
        error: 'The AI did not return an answer for that question. Please try rephrasing your question.',
      });
    }

    return res.json({
      answer,
      subject,
      language,
      model: GEMINI_MODEL,
    });
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : 500;
    const message = err && typeof err.message === 'string' ? err.message : '';

    console.error('[Gemini API Error]', {
      status,
      model: GEMINI_MODEL,
      message: message.slice(0, 250),
    });

    if (
      (status === 400 &&
        (message.includes('API_KEY_INVALID') ||
          message.includes('API_KEY_EXPIRED') ||
          message.includes('API key not valid') ||
          message.includes('API key expired'))) ||
      status === 401 ||
      status === 403 ||
      message.includes('PERMISSION_DENIED')
    ) {
      return res.status(502).json({
        error:
          'The configured Gemini API key was rejected or expired. Please verify GEMINI_API_KEY in your .env configuration or AI Studio Secrets.',
        code: 'UPSTREAM_AUTH_ERROR',
      });
    }

    if (status === 429 || message.includes('RESOURCE_EXHAUSTED')) {
      return res.status(429).json({
        error: 'The AI service is currently receiving high traffic. Please wait a moment and try again.',
        code: 'UPSTREAM_RATE_LIMIT',
      });
    }

    if (status === 404 || message.includes('NOT_FOUND')) {
      return res.status(502).json({
        error: `The configured AI model (${GEMINI_MODEL}) could not be reached. Please verify GEMINI_MODEL in your .env file.`,
        code: 'UPSTREAM_MODEL_NOT_FOUND',
      });
    }

    if (status === 400) {
      return res.status(400).json({
        error: 'The AI service could not process this request. Please check your question or model settings.',
        code: 'UPSTREAM_BAD_REQUEST',
      });
    }

    return res.status(502).json({
      error: 'Unable to generate an answer right now due to a service error. Please try again shortly.',
      code: `UPSTREAM_${status}`,
    });
  }
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/contact', contactLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = sanitizeText(body.name, 100);
  const email = sanitizeText(body.email, 150).toLowerCase();
  const subject = sanitizeText(body.subject, 150);
  const message = sanitizeText(body.message, 2000);

  if (name.length < 2) {
    return res.status(400).json({ error: 'Please enter your name (at least 2 characters).' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (subject.length < 3) {
    return res.status(400).json({ error: 'Please enter a subject (at least 3 characters).' });
  }
  if (message.length < 10) {
    return res.status(400).json({ error: 'Please enter a message of at least 10 characters.' });
  }

  const record = {
    id: crypto.randomUUID(),
    name,
    email,
    subject,
    message,
    submittedAt: new Date().toISOString(),
  };

  try {
    await saveContactMessage(record);
    return res.status(201).json({
      ok: true,
      id: record.id,
      message:
        'Thank you for your message. It has been saved securely on our server for review by our team.',
    });
  } catch (err) {
    console.error('[Contact Storage Error]', err);
    return res.status(500).json({
      error: 'We could not save your message right now. Please try again later.',
    });
  }
});

// Clean route aliases for HTML pages
const PAGE_ROUTES = new Map([
  ['/', 'index.html'],
  ['/about', 'about.html'],
  ['/contact', 'contact.html'],
  ['/privacy', 'privacy.html'],
  ['/disclaimer', 'disclaimer.html'],
  ['/terms', 'terms.html'],
]);

for (const [routePath, fileName] of PAGE_ROUTES.entries()) {
  app.get(routePath, (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, fileName));
  });
}

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    maxAge: '1h',
  })
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (!IS_SERVERLESS) {
  ensureDataDir()
    .catch((err) => {
      console.error('[Startup Warning] Could not initialize data directory:', err);
    })
    .finally(() => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`${SITE_NAME} running at http://localhost:${PORT}`);
        if (!getConfiguredApiKey()) {
          console.warn(
            [
              '',
              '------------------------------------------------------------------',
              'WARNING: GEMINI_API_KEY is missing or still set to a placeholder.',
              'To enable AI answers:',
              '  1. Copy .env.example to .env',
              '  2. Paste your Google Gemini API key into GEMINI_API_KEY',
              '  3. Restart the server',
              '------------------------------------------------------------------',
              '',
            ].join('\n')
          );
        }
      });
    });
}

export { app };
export default app;
