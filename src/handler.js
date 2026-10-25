// Turns raw Baileys messages into plugin calls.
const NodeCache = require('node-cache');
const { isJidGroup } = require('@whiskeysockets/baileys');
const config = require('./config');
const { getCommands, getPassives } = require('./events');
const { Sudo, Settings } = require('./db');
const H = require('./helpers');

const PREFIX_RE = new RegExp(config.HANDLERS);
const seen = new NodeCache({ stdTTL: 300, useClones: false });
const MAX_AGE_SECONDS = 60;
const PUBLIC = new Set([
    'help', 'alive', 'ping', 'sticker', 'toimg', 'ttp', 'song', 'video', 'yt', 'dl',
    'wiki', 'weather', 'calc', 'unit', 'tts', 'trt', 'short', 'ss', 'meme', 'animepic',
    'currency', 'github', 'movie', 'locate', 'ocr',
]);// ignore stale messages (history sync / long downtime)

let table = null;
function commandTable() {
    if (table) return table;
    table = new Map();
    for (const cmd of getCommands()) for (const n of cmd.names) if (!table.has(n)) table.set(n, cmd);
    return table;
}

function buildCtx(sock, msg) {
    const jid = msg.key.remoteJid;
    const isGroup = isJidGroup(jid);
    const fromMe = !!msg.key.fromMe;
    const botIds = [...H.getBotIds(sock)];

    const candidates = fromMe
        ? botIds
        : [msg.key.participant, msg.key.participantAlt, isGroup ? null : jid, msg.key.remoteJidAlt].filter(Boolean);
    const sender = fromMe ? botIds[0] : (msg.key.participant || jid);

    const sudo = Sudo.all();
    const isOwner = fromMe || candidates.some(c => sudo.includes(H.num(c)));

    const ctx = {
        sock, msg, jid, isGroup, fromMe, isOwner, sender, senderIds: candidates,
        prefix: config.PREFIX,
        text: H.getText(msg),
        reply: (text, extra = {}) => sock.sendMessage(jid, { text, ...extra }, { quoted: msg }),
        send: (content, opts = {}) => sock.sendMessage(jid, content, { quoted: msg, ...opts }),
    };
    return ctx;
}

async function processMessage(sock, msg) {
    console.log('[DEBUG MESSAGE]', JSON.stringify({
    type: msg.message ? Object.keys(msg.message) : [],
    fromMe: msg.key?.fromMe,
    jid: msg.key?.remoteJid,
    text: H.getText(msg),
    timestamp: msg.messageTimestamp?.toString?.() ?? msg.messageTimestamp
}));
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

    const dedupeKey = `${jid}:${msg.key.id}`;
    if (seen.has(dedupeKey)) return;
    seen.set(dedupeKey, 1);

    const ts = Number(msg.messageTimestamp?.toNumber ? msg.messageTimestamp.toNumber() : msg.messageTimestamp) || 0;
    if (ts && Date.now() / 1000 - ts > MAX_AGE_SECONDS) return;

    if (H.unwrap(msg).protocolMessage) return;

    const ctx = buildCtx(sock, msg);

    if (config.SEND_READ && !ctx.fromMe) sock.readMessages([msg.key]).catch(() => {});

    for (const passive of getPassives()) {
        try { await passive(ctx); } catch (e) { console.error('Passive plugin error:', e.message); }
    }

    // ───── command dispatch ─────
    const text = ctx.text;
    if (!text) return;
    const pm = PREFIX_RE.exec(text);
    if (!pm || pm.index !== 0 || !pm[0].length) return;

    const parsed = /^(\S+)\s*([\s\S]*)$/.exec(text.slice(pm[0].length).trim());
    if (!parsed) return;
    const name = parsed[1].toLowerCase();
    const match = parsed[2].trim() || null;

    const cmd = commandTable().get(name);
    if (!cmd) return;
    const o = cmd.options;

        // permissions: owner/sudo-only commands, or "public" commands when mode is public
    const workType = Settings.get('workType', config.WORK_TYPE);
    const isPublicCmd = o.fromMe === false || PUBLIC.has(cmd.names[0]);
    if (!isPublicCmd) { if (!ctx.isOwner) return; }
    else if (!ctx.isOwner && workType !== 'public') return;

    if (o.onlyGroup && !ctx.isGroup) return ctx.reply('❌ This command can only be used in groups.');
    if (o.onlyPm && ctx.isGroup) return ctx.reply('❌ This command can only be used in private chats.');

    try {
        await cmd.handler(sock, msg, match, ctx);
    } catch (err) {
        console.error(`Error in command [${name}]:`, err);
        await ctx.reply(`❌ Error: ${err.message}`).catch(() => {});
    }
}

function handleUpsert(sock, { messages }) {
    for (const msg of messages) {
        // not awaited: a slow command (download, ffmpeg) must not block other messages
        processMessage(sock, msg).catch(e => console.error('Message handler error:', e.message));
    }
}

module.exports = { handleUpsert };
