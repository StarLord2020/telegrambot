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
    const hay = `${a.title || ''} ${a.performer || ''}`;
    return normalize(hay).includes(q);
  });
  return results.slice(0, limit);
}

// no debug storage

// Commands
function formatIds(ctx) {
  const chat = ctx.chat;
  const from = ctx.from;
  const parts = [];
  if (chat) parts.push(`chat_id: ${chat.id} (${chat.type})`);
  if (from) parts.push(`user_id: ${from.id}${from.username ? ` (@${from.username})` : ''}`);
  return parts.join('\n');
}

async function replyWithIds(ctx) {
  try {
    await ctx.reply(formatIds(ctx));
  } catch {}
}

bot.start((ctx) => {
  const payload = ctx.startPayload || '';
  if (payload.toLowerCase() === 'id' || payload.toLowerCase() === 'getid') {
    return replyWithIds(ctx);
  }
  return ctx.reply(
    'Привет! Я инлайн-бот для отправки аудио.\n' +
      'Напиши в любом чате: @имя_бота запрос\n' +
      'и выбери трек из списка.\n' +
      'Команда /id — показать chat_id.'
  );
});

bot.command('id', replyWithIds);
bot.command('myid', replyWithIds);

// Inline mode handler
bot.on('inline_query', async (ctx) => {
  const q = ctx.inlineQuery?.query || '';
  const items = searchAudios(q, 25);
  const results = items.map((a, idx) => {
    const id = `${a.id || a.file_unique_id || idx}`;
    if (a.file_id) {
      // Use Telegram-cached audio
      return {
        type: 'audio',
        id,
        audio_file_id: a.file_id,
        caption: a.caption || undefined,
      };
    }
    // Use external URL
    return {
      type: 'audio',
      id,
      audio_url: a.url,
      title: a.title || 'Audio',
      performer: a.performer || undefined,
      caption: a.caption || undefined,
    };
  });

  try {
    await ctx.answerInlineQuery(results, {
      cache_time: 5, // small cache while iterating
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

// When you send an audio to the bot in DM, reply with a ready JSON
bot.on('message', async (ctx) => {
  if (ctx.chat?.type !== 'private') return; // only DM
  const m = ctx.message;

  // Prefer audio
  if (m.audio) {
    const audio = m.audio;
    const entry = {
      id: audio.file_unique_id || crypto.randomUUID(),
      title: audio.title || (m.caption || 'Audio'),
      performer: audio.performer || undefined,
      file_id: audio.file_id,
      caption: m.caption || undefined,
    };
    console.log('Add this to data/audios.json:', entry);
    try {
      await ctx.reply(
        [
          'Нашёл аудио. Добавьте в data/audios.json и задеплойте:',
          JSON.stringify(entry, null, 2),
        ].join('\n')
      );
    } catch {}
    return;
  }

  // Also support document that looks like audio
  if (m.document && (m.document.mime_type?.startsWith('audio/') || /\.(mp3|m4a|ogg|flac|wav)$/i.test(m.document.file_name || ''))) {
    const d = m.document;
    const baseTitle = (d.file_name || 'Audio').replace(/\.[^.]+$/, '');
    const entry = {
      id: d.file_unique_id || crypto.randomUUID(),
      title: baseTitle,
      file_id: d.file_id,
      caption: m.caption || undefined,
    };
    console.log('Add this to data/audios.json:', entry);
    try {
      await ctx.reply(
        [
          'Принял файл как аудио. Добавьте в data/audios.json и задеплойте:',
          JSON.stringify(entry, null, 2),
        ].join('\n')
      );
    } catch {}
    return;
  }

  // If it was a voice message
  if (m.voice) {
    try {
      await ctx.reply('Это голосовое. Пожалуйста, отправьте аудио как «Музыка» или файл (mp3/m4a/ogg).');
    } catch {}
    return;
  }
});

// no debug endpoints

// Health endpoint
app.get('/', (_req, res) => {
  res.json({ ok: true, mode: USE_POLLING ? 'polling' : 'webhook' });
});

async function main() {
  // Log deep-link to get chat id
  try {
    const me = await bot.telegram.getMe();
    if (me?.username) {
      console.log(`Chat ID link: https://t.me/${me.username}?start=id`);
    }
  } catch {}
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

    await bot.telegram.setWebhook(webhookUrl);
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
