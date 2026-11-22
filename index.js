'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, AttachmentBuilder, PermissionFlagsBits, ChannelType, MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');
const { parseBid, parseAdminPrice, isBidLike, formatPrice: fp, parseEndTime, fmtDate } = require('./utils');

// =====================================================================
// ตั้งค่า (ใส่ในไฟล์ .env)
// =====================================================================
const CFG = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  customerRole: process.env.CUSTOMER_ROLE_ID,
  catActive: process.env.CATEGORY_ACTIVE_ID,   // กำลังเริ่มประมูล
  catWaiting: process.env.CATEGORY_WAITING_ID, // รอรับของ
  catClosed: process.env.CATEGORY_CLOSED_ID,   // ปิดตู้
  staffRoles: (process.env.STAFF_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  shopName: process.env.SHOP_NAME || 'Beb Beb shop',
  title: process.env.SHOP_TITLE || `${process.env.SHOP_NAME || 'Beb Beb shop'} Auction ~ ✿`,
  reminderMs: 5 * 60 * 1000,                                  // ทุก 5 นาที (เฉพาะถ้ามีคนบิดใหม่)
  blockSellerBid: process.env.BLOCK_SELLER_BID !== 'false',   // กันผู้ฝากบิดสินค้าตัวเอง
  noBidGoTo: process.env.NO_BID_GOTO === 'waiting' ? 'waiting' : 'closed', // ไม่มีคนบิดให้ไปหมวดไหน
  dbFile: path.join(__dirname, 'auctions.json'),
};

for (const k of ['token', 'guildId', 'customerRole', 'catActive', 'catWaiting', 'catClosed']) {
  if (!CFG[k]) {
    console.error(`❌ ยังไม่ได้ตั้งค่า ${k} ในไฟล์ .env`);
    process.exit(1);
  }
}

// =====================================================================
// ฐานข้อมูล (ไฟล์ JSON)
// =====================================================================
let db = { nextId: 1, auctions: {} };
try { db = JSON.parse(fs.readFileSync(CFG.dbFile, 'utf8')); } catch { /* เริ่มใหม่ */ }

function saveDb() {
  const tmp = `${CFG.dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, CFG.dbFile);
}
const activeByChannel = (cid) =>
  Object.values(db.auctions).find((a) => a.channelId === cid && a.status === 'active');
const topBid = (a) => a.bids[a.bids.length - 1] || null;

// ล็อกทีละห้อง กันคนบิดพร้อมกันแล้วราคาชนกัน
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// =====================================================================
// Discord client
// =====================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const ephemeral = MessageFlags.Ephemeral;

function isStaff(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    CFG.staffRoles.some((r) => member.roles.cache.has(r))
  );
}

// ---------- หน้าตา ----------
function auctionEmbed(a) {
  const active = a.status === 'active';
  const top = topBid(a);
  const lines = [
    `# ✧ ชื่อสินค้า : \`${a.name}\``,

    `# ✧ เปิดประมูล : \`${fp(a.start)}\``,

    `# ✧ บิดทีละ : \`${fp(a.step)}\``,
    
    `# ✧ ทุบโต๊ะ : \`${fp(a.buyNow)}\``,

    `# ✧ เวลาปิด : \`${fmtDate(a.endAt)}\``,
  ];
  if (a.adminId) lines.push(`✧ ผู้ดูแลตู้ : <@${a.adminId}>`);
  if (active) {
    lines.push(top ? `✧ นำอยู่ : \`${fp(top.amount)}\` โดย <@${top.userId}>` : '✧ นำอยู่ : `ยังไม่มีผู้บิด`');
  } else if (a.closeReason === 'cancel') {
    lines.push('✧ สถานะ : `ยกเลิกการประมูล`');
  } else if (a.winnerId) {
    lines.push(`✧ ผู้ชนะ : <@${a.winnerId}> ที่ \`${fp(a.finalPrice)}\``);
  } else {
    lines.push('✧ สถานะ : `ไม่มีผู้บิด`');
  }
  lines.push('', `Tag : <@&${CFG.customerRole}>`);

  return new EmbedBuilder()
    .setColor(active ? 0xc0396b : 0x6b6b6b)
    .setTitle(active ? CFG.title : `${CFG.title} (จบแล้ว)`)
    .setDescription(lines.join('\n'))
    .setImage(`attachment://${a.imageName}`)
    .setFooter({ text: CFG.shopName });
}

function auctionComponents(a) {
  const rules = new StringSelectMenuBuilder()
    .setCustomId(`auc:rules:${a.id}`)
    .setPlaceholder('กฎพื้นฐานการลงบิด')
    .addOptions(
      { label: 'วิธีบิด', value: 'how' },
      { label: 'ราคาขั้นต่ำที่บิดได้', value: 'min' },
      { label: 'ทุบโต๊ะ', value: 'buynow' },
      { label: 'การปิดประมูล', value: 'close' },
    );
  const buy = new ButtonBuilder()
    .setCustomId(`auc:buynow:${a.id}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel('ทุบโต๊ะ')
    .setEmoji('🔨');
  return [new ActionRowBuilder().addComponents(buy), new ActionRowBuilder().addComponents(rules)];
}

function rulesText(a, key) {
  const top = topBid(a);
  const min = top ? top.amount + a.step : a.start;
  switch (key) {
    case 'how':
      return 'พิมพ์ราคาที่ต้องการในห้องนี้ได้เลย เช่น `500k` `1.5m` `500000` `5แสน` (พิมพ์เฉพาะราคา)';
    case 'min':
      return `ตอนนี้ต้องบิดอย่างน้อย **${fp(min)}** (บิดทีละ ${fp(a.step)})\nถ้าบิดต่ำกว่านี้ ข้อความจะถูกลบทันที`;
    case 'buynow':
      return `กดปุ่ม 🔨 ทุบโต๊ะ เพื่อซื้อทันทีที่ **${fp(a.buyNow)}**\nหรือบิดถึง ${fp(a.buyNow)} ก็ถือว่าทุบโต๊ะเช่นกัน`;
    default:
      return `ปิดประมูลตรงเวลา **${fmtDate(a.endAt)}** (<t:${Math.floor(a.endAt / 1000)}:R>)`;
  }
}

async function tempNotice(channel, content, userId, ms = 6000) {
  const m = await channel.send({ content, allowedMentions: { users: [userId] } }).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), ms);
}

// ---------- สิทธิ์ห้อง + ย้ายหมวดหมู่ ----------
// สีหัวใจหน้าชื่อห้อง: กำลังประมูล 💚 / รอส่งของ 💛 / ปิดตู้ ❤️
const HEARTS = { active: '💚', waiting: '💛', closed: '❤️' };
const channelNameFor = (baseName, stage) => `「${HEARTS[stage]}」${baseName}`.slice(0, 100);

async function applyStage(a, channel, stage) {
  const everyone = channel.guild.roles.everyone;
  const people = [a.winnerId, a.sellerId].filter(Boolean);

  if (stage === 'waiting') {
    await channel.permissionOverwrites.edit(everyone, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: false, AddReactions: false,
    });
    for (const id of new Set(people)) {
      await channel.permissionOverwrites.edit(id, {
        ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true, EmbedLinks: true,
      });
    }
    await channel.setParent(CFG.catWaiting, { lockPermissions: false });
    channel.setName(channelNameFor(a.baseName, 'waiting')).catch((e) => console.error('rename:', e.message));
  } else {
    await channel.permissionOverwrites.edit(everyone, { SendMessages: false, AddReactions: false });
    for (const id of new Set(people)) {
      await channel.permissionOverwrites.edit(id, { SendMessages: false });
    }
    await channel.setParent(CFG.catClosed, { lockPermissions: false });
    channel.setName(channelNameFor(a.baseName, 'closed')).catch((e) => console.error('rename:', e.message));
  }
}

// ---------- จบประมูล (ต้องเรียกตอนถือล็อกห้องอยู่) ----------
async function finalize(a, { reason, winnerId = null, price = null }) {
  const top = topBid(a);
  if (reason === 'time' && top) { winnerId = top.userId; price = top.amount; }

  a.closeReason = reason;
  a.endedAt = Date.now();
  a.winnerId = winnerId;
  a.finalPrice = price;
  a.dirty = false;
  a.nextReminderAt = null;
  if (reason === 'cancel') a.status = 'closed';
  else if (winnerId) a.status = 'waiting';
  else a.status = CFG.noBidGoTo;
  saveDb();

  const channel = await client.channels.fetch(a.channelId).catch(() => null);
  if (!channel) return;

  channel.messages.edit(a.messageId, { embeds: [auctionEmbed(a)], components: [] }).catch(() => {});

  let content;
  if (reason === 'cancel') content = '## ❌ ยกเลิกการประมูล';
  else if (winnerId) {
    content =
      `${reason === 'buynow' ? '### 🔨 ทุบโต๊ะ!\n' : ''}` +
      `## ผู้ชนะการประมูล\n- <@${winnerId}>\n## ยอดราคาที่ได้\n- **${fp(price)}**`;
  } else content = '## หมดเวลาประมูล\n- ไม่มีผู้บิด';
  await channel.send({ content, allowedMentions: { users: winnerId ? [winnerId] : [] } }).catch(() => {});

  if (a.status === 'waiting') {
    const who = [...new Set([a.sellerId, a.winnerId].filter(Boolean))];
    const done = new ButtonBuilder()
      .setCustomId(`auc:done:${a.id}`).setStyle(ButtonStyle.Success).setLabel('ส่งของเรียบร้อย').setEmoji('✅');
    await channel.send({
      content:
        `📦 **รอรับของ** ${who.map((id) => `<@${id}>`).join(' ')}\n` +
        'รับของ แท็คผู้ดูแลตู้ได้เลยนคะ',
      components: [new ActionRowBuilder().addComponents(done)],
      allowedMentions: { users: who },
    }).catch(() => {});
  }

  try {
    await applyStage(a, channel, a.status);
  } catch (e) {
    console.error('ย้ายหมวด/ตั้งสิทธิ์ไม่สำเร็จ:', e.message);
    await channel.send('⚠️ ย้ายหมวดหมู่ไม่สำเร็จ ตรวจสอบสิทธิ์ของบอท (Manage Channels)').catch(() => {});
  }
}

// =====================================================================
// รับบิดจากข้อความ
// =====================================================================
async function handleBid(message) {
  if (!activeByChannel(message.channelId)) return;
  const content = message.content.trim();
  if (!content) return;
  if (/^[5๕]{3,}$/.test(content)) return; // 555 = หัวเราะ ไม่ใช่ราคา
  if (!isBidLike(content)) return; // ข้อความคุยทั่วไป ไม่เกี่ยวกับการบิด

  await withLock(message.channelId, async () => {
    const a = activeByChannel(message.channelId);
    if (!a) return;

    // อ่านราคาโดยดูบริบทราคาปัจจุบัน (พิมพ์ 20 = 20k, 1.1 = 1.1m ฯลฯ)
    const top = topBid(a);
    const amount = parseBid(content, { ref: top ? top.amount : a.start, limit: a.buyNow * 1.5 });
    if (amount === null) return;

    if (Date.now() >= a.endAt) { // หมดเวลาแล้วแต่ตัวจับเวลายังไม่ทันปิด
      await finalize(a, { reason: 'time' });
      message.delete().catch(() => {});
      return;
    }

    if (CFG.blockSellerBid && a.sellerId === message.author.id) {
      message.delete().catch(() => {});
      return tempNotice(message.channel, `<@${message.author.id}> ผู้ฝากประมูลบิดสินค้าตัวเองไม่ได้`, message.author.id);
    }

    const min = top ? top.amount + a.step : a.start; // บิดแรกเท่ากับราคาเปิดได้
    if (amount < min) {
      message.delete().catch(() => {});
      return tempNotice(
        message.channel,
        `<@${message.author.id}> บิดต่ำกว่าที่กำหนด ต้องบิดอย่างน้อย **${fp(min)}**`,
        message.author.id,
      );
    }

    // บิดถึงราคาทุบโต๊ะ = ทุบโต๊ะเลย
    if (amount >= a.buyNow) {
      a.bids.push({ userId: message.author.id, amount: a.buyNow, at: Date.now() });
      return finalize(a, { reason: 'buynow', winnerId: message.author.id, price: a.buyNow });
    }

    a.bids.push({ userId: message.author.id, amount, at: Date.now() });
    if (!a.dirty) { a.dirty = true; a.nextReminderAt = Date.now() + CFG.reminderMs; }
    saveDb();

    await message.reply({
      content: `## นำ${fp(amount)}\n<@&${CFG.customerRole}>`,
      allowedMentions: { roles: [CFG.customerRole], repliedUser: false },
    }).catch(() => {});
    message.channel.messages.edit(a.messageId, { embeds: [auctionEmbed(a)] }).catch(() => {});
  });
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || !message.inGuild()) return;
  handleBid(message).catch((e) => console.error('bid error:', e));
});

// =====================================================================
// ตัวจับเวลา: ปิดอัตโนมัติ + สรุปทุก 5 นาที (เฉพาะเมื่อมีคนบิดใหม่)
// =====================================================================
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const a0 of Object.values(db.auctions)) {
      if (a0.status !== 'active') continue;
      if (now >= a0.endAt) {
        await withLock(a0.channelId, async () => {
          if (a0.status === 'active') await finalize(a0, { reason: 'time' });
        });
      } else if (a0.dirty && a0.nextReminderAt && now >= a0.nextReminderAt) {
        await withLock(a0.channelId, async () => {
          if (a0.status !== 'active' || !a0.dirty) return;
          const top = topBid(a0);
          a0.dirty = false;
          a0.nextReminderAt = null;
          saveDb();
          if (!top) return;
          const ch = await client.channels.fetch(a0.channelId).catch(() => null);
          await ch?.send({
            content:
              `## นำอยู่ที่ ${fp(top.amount)}\n<@${top.userId}>\n<@&${CFG.customerRole}>\n` +
              `⏰ ปิดประมูล : ${fmtDate(a0.endAt)} (<t:${Math.floor(a0.endAt / 1000)}:R>)`,
            allowedMentions: { roles: [CFG.customerRole] },
          }).catch(() => {});
        });
      }
    }
  } catch (e) {
    console.error('tick error:', e);
  } finally {
    ticking = false;
  }
}

// =====================================================================
// คำสั่ง Slash
// =====================================================================
const commands = [
  new SlashCommandBuilder()
    .setName('เปิดตู้')
    .setDescription('เปิดตู้ประมูลใหม่ บอทสร้างห้องให้เอง (แอดมิน)')
    .addStringOption((o) => o.setName('ชื่อสินค้า').setDescription('ชื่อสินค้า').setRequired(true).setMaxLength(100))
    .addAttachmentOption((o) => o.setName('รูปภาพ').setDescription('แนบรูปสินค้าจากเครื่องได้เลย').setRequired(true))
    .addStringOption((o) => o.setName('เปิดประมูล').setDescription('ราคาเริ่มต้น เช่น 250k').setRequired(true))
    .addStringOption((o) => o.setName('บิดทีละ').setDescription('บิดทีละขั้นต่ำเท่าไหร่ เช่น 50k').setRequired(true))
    .addStringOption((o) => o.setName('ทุบโต๊ะ').setDescription('ราคาซื้อทันที เช่น 600k').setRequired(true))
    .addStringOption((o) =>
      o.setName('เวลาปิด').setDescription('เช่น 22/11 23:00 หรือ 23:00 หรือ +30m (นับจากตอนนี้)').setRequired(true))
    .addUserOption((o) => o.setName('ผู้ฝาก').setDescription('คนที่ฝากประมูล (ถ้ามี)')),
  new SlashCommandBuilder()
    .setName('ยกเลิกตู้')
    .setDescription('ยกเลิกประมูลในห้องนี้ (แอดมิน)'),
].map((c) => c.toJSON());

async function cmdOpen(i) {
  await i.deferReply({ flags: ephemeral });
  if (!isStaff(i.member)) return i.editReply('❌ ใช้ได้เฉพาะแอดมิน');
  if (!i.guild) return i.editReply('❌ ใช้ได้ในเซิร์ฟเวอร์เท่านั้น');

  const name = i.options.getString('ชื่อสินค้า', true).replace(/`/g, "'").trim();
  const img = i.options.getAttachment('รูปภาพ', true);
  const endAt = parseEndTime(i.options.getString('เวลาปิด', true));
  const seller = i.options.getUser('ผู้ฝาก');

  const sR = parseAdminPrice(i.options.getString('เปิดประมูล', true));
  const start = sR.value;
  const stR = parseAdminPrice(i.options.getString('บิดทีละ', true), { ref: start, limit: start });
  const bR = parseAdminPrice(i.options.getString('ทุบโต๊ะ', true), { ref: start, limit: start ? start * 20 : undefined });
  const step = stR.value;
  const buyNow = bR.value;

  const errs = [];
  if (sR.error) errs.push(`"เปิดประมูล": ${sR.error}`);
  if (stR.error) errs.push(`"บิดทีละ": ${stR.error}`);
  if (bR.error) errs.push(`"ทุบโต๊ะ": ${bR.error}`);
  if (start && buyNow && buyNow <= start) errs.push('ราคาทุบโต๊ะต้องมากกว่าราคาเปิดประมูล');
  if (!endAt) errs.push('อ่านเวลาปิดไม่ออก (ลอง 22/11 23:00 หรือ +30m)');
  else if (endAt <= Date.now() + 10000) errs.push('เวลาปิดต้องเป็นเวลาในอนาคต');
  if (!img.contentType || !/^image\/(png|jpe?g|gif|webp)/.test(img.contentType)) errs.push('ไฟล์ที่แนบต้องเป็นรูปภาพ');
  if (errs.length) return i.editReply(`❌ ${errs.join('\n❌ ')}`);

  const ext = (path.extname(img.name || '') || '.png').toLowerCase();
  const imageName = `item${['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) ? ext : '.png'}`;
  let buf;
  try {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(res.status);
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return i.editReply('❌ โหลดรูปไม่สำเร็จ ลองแนบใหม่อีกครั้ง');
  }

  // สร้างห้องประมูลใหม่เอง ชื่อห้อง = ชื่อสินค้า มี 「💚」 นำหน้า
  const baseName = name.replace(/[\r\n]+/g, ' ').slice(0, 80);
  let channel;
  try {
    channel = await i.guild.channels.create({
      name: channelNameFor(baseName, 'active'),
      type: ChannelType.GuildText,
      parent: CFG.catActive,
      permissionOverwrites: [{
        id: i.guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      }],
    });
  } catch (e) {
    return i.editReply(`❌ สร้างห้องไม่สำเร็จ: ${e.message}\nตรวจสอบสิทธิ์บอท (Manage Channels), ID หมวดหมู่ใน .env และหมวดหมู่ต้องมีห้องไม่เกิน 50`);
  }

  const a = {
    id: String(db.nextId++), guildId: i.guildId, channelId: channel.id, messageId: null,
    sellerId: seller?.id || null, adminId: i.user.id, name, baseName, imageName, start, step, buyNow, endAt,
    createdAt: Date.now(), status: 'active', bids: [], dirty: false, nextReminderAt: null,
    closeReason: null, winnerId: null, finalPrice: null,
  };

  let msg;
  try {
    msg = await channel.send({
      content: `<@&${CFG.customerRole}>`,
      embeds: [auctionEmbed(a)],
      files: [new AttachmentBuilder(buf, { name: imageName })],
      components: auctionComponents(a),
      allowedMentions: { roles: [CFG.customerRole] },
    });
  } catch (e) {
    await channel.delete().catch(() => {});
    return i.editReply(`❌ ส่งข้อความประมูลไม่สำเร็จ: ${e.message}`);
  }
  a.messageId = msg.id;
  db.auctions[a.id] = a;
  saveDb();

  return i.editReply(
    `✅ เปิดตู้แล้ว <#${channel.id}>\nเปิด ${fp(start)} / บิดทีละ ${fp(step)} / ทุบโต๊ะ ${fp(buyNow)}\nปิดประมูล ${fmtDate(endAt)}`,
  );
}

async function cmdCancel(i) {
  await i.deferReply({ flags: ephemeral });
  if (!isStaff(i.member)) return i.editReply('❌ ใช้ได้เฉพาะแอดมิน');
  const a = activeByChannel(i.channelId);
  if (!a) return i.editReply('❌ ห้องนี้ไม่มีประมูลที่กำลังเปิดอยู่');
  await withLock(i.channelId, async () => {
    const cur = activeByChannel(i.channelId);
    if (cur) await finalize(cur, { reason: 'cancel' });
  });
  return i.editReply('✅ ยกเลิกประมูลแล้ว');
}

// =====================================================================
// ปุ่ม / เมนู
// =====================================================================
async function onButton(i) {
  const [, action, id] = i.customId.split(':');
  const a = db.auctions[id];

  if (action === 'buynow') {
    if (!a || a.status !== 'active') return i.reply({ content: 'ประมูลนี้จบไปแล้ว', flags: ephemeral });
    if (CFG.blockSellerBid && a.sellerId === i.user.id) {
      return i.reply({ content: 'ผู้ฝากประมูลทุบโต๊ะสินค้าตัวเองไม่ได้', flags: ephemeral });
    }
    return i.reply({
      content: `🔨 ยืนยันทุบโต๊ะที่ **${fp(a.buyNow)}** ใช่ไหม? ถ้ายืนยันจะได้สินค้าทันที`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`auc:buyyes:${a.id}`).setStyle(ButtonStyle.Danger).setLabel('ยืนยันทุบโต๊ะ'),
        new ButtonBuilder().setCustomId(`auc:buyno:${a.id}`).setStyle(ButtonStyle.Secondary).setLabel('ยกเลิก'),
      )],
      flags: ephemeral,
    });
  }

  if (action === 'buyno') return i.update({ content: 'ยกเลิกแล้ว', components: [] });

  if (action === 'buyyes') {
    await i.update({ content: '⏳ กำลังทุบโต๊ะ...', components: [] });
    if (!a) return i.editReply('ประมูลนี้จบไปแล้ว');
    let result = 'ประมูลนี้จบไปแล้ว';
    await withLock(a.channelId, async () => {
      if (a.status !== 'active') return;
      if (Date.now() >= a.endAt) { await finalize(a, { reason: 'time' }); return; }
      a.bids.push({ userId: i.user.id, amount: a.buyNow, at: Date.now() });
      await finalize(a, { reason: 'buynow', winnerId: i.user.id, price: a.buyNow });
      result = '✅ ทุบโต๊ะสำเร็จ!';
    });
    return i.editReply(result);
  }

  if (action === 'done') {
    if (!isStaff(i.member)) return i.reply({ content: '❌ ใช้ได้เฉพาะแอดมิน', flags: ephemeral });
    if (!a || a.status !== 'waiting') return i.reply({ content: 'ตู้นี้ไม่ได้อยู่ในสถานะรอรับของ', flags: ephemeral });
    await i.update({ components: [] });
    await withLock(a.channelId, async () => {
      a.status = 'closed';
      a.deliveredAt = Date.now();
      saveDb();
      await i.channel.send('✅ ส่งของเรียบร้อย **ปิดตู้แล้ว**').catch(() => {});
      await applyStage(a, i.channel, 'closed').catch((e) => console.error(e.message));
    });
  }
}

async function onSelect(i) {
  const [, action, id] = i.customId.split(':');
  if (action !== 'rules') return;
  const a = db.auctions[id];
  if (!a) return i.reply({ content: 'ไม่พบข้อมูลประมูล', flags: ephemeral });
  return i.reply({ content: rulesText(a, i.values[0]), flags: ephemeral });
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === 'เปิดตู้') return await cmdOpen(i);
      if (i.commandName === 'ยกเลิกตู้') return await cmdCancel(i);
    } else if (i.isButton()) {
      return await onButton(i);
    } else if (i.isStringSelectMenu()) {
      return await onSelect(i);
    }
  } catch (e) {
    console.error('interaction error:', e);
    const msg = { content: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', flags: ephemeral };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ ออนไลน์ในชื่อ ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(CFG.guildId);
    await guild.commands.set(commands);
    console.log('✅ ลงทะเบียนคำสั่งแล้ว');
  } catch (e) {
    console.error('ลงทะเบียนคำสั่งไม่สำเร็จ:', e.message);
  }
  setInterval(tick, 1000);
});

client.login(CFG.token);
