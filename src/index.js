import express from 'express';
import { Telegraf } from 'telegraf';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var');
  process.exit(1);
}

const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g. https://your-app.up.railway.app
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(8).toString('hex');
const WEBHOOK_PATH = `/telegraf/${WEBHOOK_SECRET}`;
const PORT = process.env.PORT || 3000;
const USE_POLLING = process.env.USE_POLLING === 'true' || (!WEBHOOK_DOMAIN && process.env.NODE_ENV !== 'production');

const app = express();
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 10_000,
});

// Load audio library
const audioPath = path.join(process.cwd(), 'data', 'audios.json');
let audioLibrary = [];
try {
  const data = fs.readFileSync(audioPath, 'utf8');
  audioLibrary = JSON.parse(data);
} catch (err) {
  console.error('Failed to load data/audios.json', err);
  process.exit(1);
}

function normalize(s) {
  return (s || '').toString().toLowerCase();
}

function searchAudios(query, limit = 25) {
  const q = normalize(query);
  if (!q) return audioLibrary.slice(0, limit);
  const results = audioLibrary.filter((a) => {
    const hay = `${a.title} ${a.performer || ''}`;
    return normalize(hay).includes(q);
  });
  return results.slice(0, limit);
}

// Commands
bot.start((ctx) => {
  return ctx.reply(
      'Привет! Я инлайн-бот для отправки аудио.\n' +
      'Напиши в любом чате: @имя_бота запрос\n' +
      'и выбери трек из списка.'
  );
});

bot.command(['id','myid'], async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const username = ctx.from?.username ? ` (@${ctx.from.username})` : '';
  try {
    await ctx.reply(`chat_id: ${chatId}\nuser_id: ${userId}${username}`);
  } catch {}
});

// Inline mode handler
bot.on('inline_query', async (ctx) => {
  const q = ctx.inlineQuery?.query || '';
  console.log('inline_query', { q, from: ctx.from?.id });
  const items = searchAudios(q, 25);
  const results = items
    .map((a, idx) => {
      const id = `${a.id || a.file_unique_id || idx}`;
      // Voice (cached)
      if (a.tg_type === 'voice' || a.is_voice === true || a.voice_file_id) {
        const voiceId = a.voice_file_id || a.file_id;
        if (!voiceId) return null;
        return {
          type: 'voice',
          id,
          voice_file_id: voiceId,
          title: a.title || 'Voice',
        };
      }
      // Document (cached)
      if (a.tg_type === 'document' || a.document_file_id) {
        const docId = a.document_file_id || a.file_id;
        if (!docId) return null;
        return {
          type: 'document',
          id,
          document_file_id: docId,
          title: a.title || 'Document',
          caption: a.caption || undefined,
          description: a.description || undefined,
        };
      }
      // Audio (cached)
      if (a.file_id) {
        return {
          type: 'audio',
          id,
          audio_file_id: a.file_id,
          caption: a.caption || undefined,
        };
      }
      // Audio by URL
      if (a.url) {
        return {
          type: 'audio',
          id,
          audio_url: a.url,
          title: a.title || 'Audio',
          performer: a.performer || undefined,
          caption: a.caption || undefined,
        };
      }
      return null;
    })
    .filter(Boolean);

  try {
    await ctx.answerInlineQuery(results, {
      cache_time: 0, // disable cache for debugging
      is_personal: true,
    });
  } catch (err) {
    console.error('answerInlineQuery error', err);
  }
});

// Optional: log chosen results
bot.on('chosen_inline_result', (ctx) => {
  const r = ctx.chosenInlineResult;
  console.log('chosen_inline_result', {
    query: r.query,
    result_id: r.result_id,
    from: r.from?.username || r.from?.id,
  });
});

// Health endpoint
app.get('/', (_req, res) => {
  res.json({ ok: true, mode: USE_POLLING ? 'polling' : 'webhook' });
});

async function main() {
  if (USE_POLLING) {
    await bot.launch();
    app.listen(PORT, () => console.log(`Health on http://localhost:${PORT}`));
    console.log('Bot started in polling mode');
  } else {
    // Webhook mode for Railway
    const domain = WEBHOOK_DOMAIN?.replace(/\/$/, '');
    const webhookUrl = `${domain}${WEBHOOK_PATH}`;

    app.use(express.json());
    app.use(bot.webhookCallback(WEBHOOK_PATH));

    await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ['inline_query', 'chosen_inline_result', 'message'],
    });
    console.log('Webhook set to', webhookUrl);

    app.listen(PORT, () => {
      console.log(`Server listening on :${PORT}`);
    });
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
