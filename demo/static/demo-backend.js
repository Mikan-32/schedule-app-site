// デモ版の裏側：本体（Python）の API をブラウザの中で再現する。
// 画面（app.js）は本体と同じものをそのまま使い、/api/... への fetch をここで受け取る。
// 予定の読み取りだけはクラウドの LLM（Cloudflare Workers の中継）を使い、
// 登録・確認待ち・同じ予定のまとめ・変更と取り消し・自分宛ての判定は本体と同じ手順で行う。
// データは審査員ごと（ブラウザごと）に分かれ、localStorage に保存する。
"use strict";

(() => {
  const CONFIG = window.DEMO_CONFIG || {};
  const STORE_KEY = "schedule-demo-v1";
  const MIN_CONFIDENCE = 0.5;
  const CHANGE_AUTO_CONFIDENCE = 0.8;
  const DEFAULT_DURATION_MIN = 60;
  const CANDIDATE_DAYS = 180;
  const CANDIDATE_LIMIT = 50;
  const CONTEXT_MESSAGES = 8;
  const CONTEXT_MINUTES = 180;
  const SIMILAR_THRESHOLD = 0.6;
  const WD = "日月火水木金土";
  const AUDIENCE_LABELS = { me: "自分宛て", all: "全員・グループ宛て", unknown: "誰宛てか分からない", others: "他の人宛て" };
  const DEFAULT_ACTIONS = { me: "add", all: "confirm", unknown: "confirm", others: "skip" };
  const ACTIONS = ["add", "confirm", "skip"];

  // ---------- 日付・時刻 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dateOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  const minutes = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const hmOf = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const nowIso = () => {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    return `${isoOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  };

  function parseTime(value) {
    const v = String(value || "").trim().replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h === 24 && mi === 0) return "23:59";
    return h <= 23 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : null;
  }
  function parseDate(value) {
    const v = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = dateOf(v);
    return isoOf(d) === v ? v : null;
  }

  // ---------- 文面（本体の formatting.py と同じ） ----------
  const dateJa = (iso) => { const d = dateOf(iso); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
  const hourJa = (hm) => { const [h, m] = hm.split(":").map(Number); return m === 0 ? `${h}時` : `${h}時${m}分`; };
  const eventLine = (e) => (e.start_time ? `${dateJa(e.date)}${hourJa(e.start_time)}から${e.title}` : `${dateJa(e.date)} 終日 ${e.title}`);
  const timeRange = (e) => (!e.start_time ? "終日" : e.end_time ? `${e.start_time}–${e.end_time}` : e.start_time);
  const whenJa = (e) => (e.start_time ? `${dateJa(e.date)}${hourJa(e.start_time)}` : `${dateJa(e.date)} 終日`);

  function changeDetails(before, after) {
    const out = [];
    if (before.date !== after.date || before.start_time !== after.start_time) out.push(`変更前: ${whenJa(before)}`);
    else if (before.end_time !== after.end_time) out.push(`終了: ${before.end_time || "なし"} → ${after.end_time || "なし"}`);
    if (before.location !== after.location) out.push(`場所: ${before.location || "なし"} → ${after.location || "なし"}`);
    return out;
  }
  const updatedMessage = (b, a) => { const d = changeDetails(b, a); return `${eventLine(a)}に変更しました` + (d.length ? `（${d.join("、")}）` : ""); };
  function mergedMessage(b, a) {
    const added = [];
    if (!b.start_time && a.start_time) added.push(`時刻「${timeRange(a)}」`);
    else if (b.end_time !== a.end_time && a.end_time) added.push(`終了時刻「${a.end_time}」`);
    if (b.location !== a.location) added.push(`場所「${a.location}」`);
    if (b.description !== a.description) added.push("補足");
    return `同じ予定の連絡をまとめました: ${eventLine(a)}に${added.join("・") || "情報"}を追加`;
  }
  function changePendingMessage(kind, before, after, conflicts, reason) {
    const lines = kind === "cancel"
      ? [`${before.title}の予定を取り消しますか？`, `対象: ${eventLine(before)}`]
      : [`${before.title}の予定を変更しますか？`, `変更前: ${eventLine(before)}`, `変更後: ${eventLine(after)}`];
    if (kind !== "cancel") {
      if (after && before.location !== after.location) lines.push(`場所: ${before.location || "なし"} → ${after.location || "なし"}`);
      conflicts.forEach((c) => lines.push(`重なる予定: ${eventLine(c)}`));
    }
    if (reason) lines.push(`（${reason}）`);
    return lines.join("\n");
  }
  function conflictMessage(ev, conflicts, likelySame) {
    const head = likelySame ? `${dateJa(ev.date)}に同じ予定があるかもしれません。追加しますか？` : `${dateJa(ev.date)}は既に予定があります。追加しますか？`;
    return [head, `新しい予定: ${eventLine(ev)}`, ...conflicts.map((c) => `既存の予定: ${eventLine(c)}`)].join("\n");
  }
  const who = (e) => { const w = [e.source_channel, e.source_author].filter(Boolean).join(" ・ "); return w ? `（${w}）` : ""; };

  // ---------- 保存 ----------
  let db = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.version === 1) return data;
      }
    } catch (_) { /* 保存できない環境ではメモリだけで動く */ }
    return seed();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (_) { /* ignore */ }
  }

  function blankEvent(fields) {
    return {
      id: null, title: "", date: todayIso(), start_time: null, end_time: null, location: "", description: "",
      status: "confirmed", source: "manual", source_message_id: "", source_author: "", source_channel: "", source_url: "",
      raw_text: "", confidence: 1, created_at: nowIso(), updated_at: null, audience: "", audience_reason: "", held: false,
      ...fields,
    };
  }

  // 見本のデータ（開いた日を基準に並べる）
  function seed() {
    const t = todayIso();
    const d = (n) => addDays(t, n);
    const team = { source: "winnotify", source_channel: "Discord 学科サーバー #チーム連絡", source_author: "リーダー", audience: "all" };
    const shift = { source: "manual", source_channel: "貼り付け", location: "教室", audience: "me" };
    const events = [
      { title: "チームミーティング", date: d(0), start_time: "14:00", end_time: "15:00", location: "301教室", ...team },
      { title: "ゆうきとご飯", date: d(1), start_time: "19:00", location: "駅前", source: "winnotify", source_channel: "Discord DM", source_author: "ゆうき", audience: "me" },
      { title: "教室 シフト", date: d(2), start_time: "16:00", end_time: "20:15", ...shift },
      { title: "教室 シフト", date: d(4), start_time: "16:00", end_time: "20:15", ...shift },
      { title: "定例ミーティング", date: d(5), start_time: "13:00", end_time: "14:00", location: "オンライン", source: "winnotify", source_channel: "Slack: #team", audience: "all" },
      { title: "教室 シフト", date: d(7), start_time: "16:00", end_time: "20:15", ...shift },
      { title: "課題提出締切", date: d(8), source: "winnotify", source_channel: "Discord 学科サーバー #お知らせ", source_author: "先生", audience: "all" },
      { title: "教室 シフト", date: d(9), start_time: "16:00", end_time: "20:15", ...shift },
      { title: "チームの打ち上げ", date: d(12), start_time: "18:30", end_time: "21:00", location: "駅前の居酒屋", ...team },
    ].map((e, i) => blankEvent({ ...e, id: i + 1 }));
    const held = blankEvent({
      id: events.length + 1, title: "学科ガイダンス", date: d(10), start_time: "10:00", end_time: "11:30", location: "大講義室",
      status: "pending", held: true, audience: "all", audience_reason: "@here 宛て", source: "winnotify",
      source_channel: "Discord 学科サーバー #お知らせ", source_author: "先生",
      raw_text: `@here ${dateOf(d(10)).getDate()}日10時から学科ガイダンスです。大講義室に集合してください`,
    });
    events.push(held);
    const ago = (min) => { const x = new Date(Date.now() - min * 60000); return x.toISOString(); };
    const notifications = [
      { id: 1, kind: "added", message: `貼り付けたメッセージ: ${eventLine(events[2])}（ほか3件）`, event_id: 3, change_id: null, read: true, created_at: ago(60 * 26) },
      { id: 2, kind: "added", message: eventLine(events[0]), event_id: 1, change_id: null, read: true, created_at: ago(60 * 5) },
      { id: 3, kind: "held", message: `追加するか確認してください（全員・グループ宛て）: ${eventLine(held)}${who(held)}`, event_id: held.id, change_id: null, read: false, created_at: ago(40) },
    ];
    return {
      version: 1,
      seq: { event: events.length, change: 0, notification: notifications.length },
      events, changes: [], notifications,
      rules: { names: ["たろう"], groups: ["IT科2年"], actions: { ...DEFAULT_ACTIONS } },
      recent: {},
      processed: [],
    };
  }

  function reset() {
    db = seed();
    jobs.clear();
    save();
  }

  // ---------- 予定・変更・通知の保存 ----------
  const getEvent = (id) => db.events.find((e) => e.id === Number(id)) || null;
  function addEvent(ev) { ev.id = ++db.seq.event; ev.created_at = nowIso(); db.events.push(ev); return ev; }
  function updateEvent(ev) { const i = db.events.findIndex((e) => e.id === ev.id); ev.updated_at = nowIso(); if (i >= 0) db.events[i] = ev; }
  function setStatus(id, status) { const e = getEvent(id); if (e) { e.status = status; e.updated_at = nowIso(); } }
  function listEvents({ statuses, onDate, from, to } = {}) {
    return db.events
      .filter((e) => (!statuses || statuses.includes(e.status)) && (!onDate || e.date === onDate) && (!from || e.date >= from) && (!to || e.date <= to))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start_time || "") < (b.start_time || "") ? -1 : (a.start_time || "") > (b.start_time || "") ? 1 : a.id - b.id));
  }
  const getChange = (id) => db.changes.find((c) => c.id === Number(id)) || null;
  function addChange(ch) { ch.id = ++db.seq.change; ch.created_at = nowIso(); ch.status = ch.status || "pending"; db.changes.push(ch); return ch; }
  function resolveChange(ch, status) { ch.status = status; ch.resolved_at = nowIso(); }
  const latestApplied = (eventId) => db.changes.filter((c) => c.event_id === eventId && c.status === "applied").sort((a, b) => b.id - a.id)[0] || null;
  function notify(kind, message, eventId = null, changeId = null) {
    const n = { id: ++db.seq.notification, kind, message, event_id: eventId, change_id: changeId, read: false, created_at: new Date().toISOString() };
    db.notifications.push(n);
    lastNotices.push(n);
    return n;
  }
  let lastNotices = []; // 直近の処理で出た通知（デモの画面に表示する）

  const fields = (e) => ({ title: e.title, date: e.date, start_time: e.start_time, end_time: e.end_time, location: e.location, description: e.description, status: e.status });
  const withFields = (e, f) => ({ ...e, ...f });
  const updatedEv = (target, change) => { const { status, ...rest } = change.after; return withFields(target, rest); };

  function toDict(e) {
    return {
      ...e, all_day: !e.start_time, gcal_synced: false,
      audience_label: AUDIENCE_LABELS[e.audience] || "", label: eventLine(e), time_range: timeRange(e),
    };
  }
  const changeDict = (c) => ({ ...c });

  // ---------- 同じ予定・重なる予定 ----------
  const SYNONYMS = [
    [/ミーティング|ミーテイング|meeting|mtg|打ち合わせ|打ち合せ|打合わせ|打合せ/g, "会議"],
    [/締め切り|締切り|〆切り|〆切|しめきり|deadline/g, "締切"],
    [/リマインダー|リマインド|reminder|再掲|再送/g, ""],
  ];
  function normalizeTitle(title) {
    let s = String(title || "").normalize("NFKC").toLowerCase();
    for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
    return s.replace(/[\s・、。,.!?「」『』()\[\]【】\-ー_~〜:;/]/g, "");
  }
  const bigrams = (s) => { const out = new Set(); if (s.length > 1) for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); else out.add(s); return out; };
  function titleScore(a, b) {
    const na = normalizeTitle(a), nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (Math.min(na.length, nb.length) >= 2 && (na.includes(nb) || nb.includes(na))) return 0.9;
    const ba = bigrams(na), bb = bigrams(nb);
    let both = 0;
    ba.forEach((x) => { if (bb.has(x)) both++; });
    return (2 * both) / (ba.size + bb.size);
  }
  const similar = (a, b) => titleScore(a, b) >= SIMILAR_THRESHOLD;
  const timesCompatible = (a, b) => !a.start_time || !b.start_time || a.start_time === b.start_time;

  function interval(e) {
    const s = minutes(e.start_time);
    const end = e.end_time && minutes(e.end_time) > s ? minutes(e.end_time) : s + DEFAULT_DURATION_MIN;
    return [s, end];
  }
  function overlaps(a, b) {
    if (a.date !== b.date) return false;
    if (!a.start_time || !b.start_time) return true;
    const [as, ae] = interval(a), [bs, be] = interval(b);
    return as < be && bs < ae;
  }
  const findConflicts = (ev) => listEvents({ statuses: ["confirmed", "pending"], onDate: ev.date }).filter((e) => e.id !== ev.id && overlaps(ev, e));
  function findSame(ev) {
    let best = null, bestKey = null;
    for (const e of listEvents({ statuses: ["confirmed", "pending"], onDate: ev.date })) {
      if (e.id === ev.id || !timesCompatible(e, ev)) continue;
      const score = titleScore(e.title, ev.title);
      if (score < SIMILAR_THRESHOLD) continue;
      const key = [e.start_time === ev.start_time ? 1 : 0, score];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = e; bestKey = key; }
    }
    return best;
  }
  function mergeCandidate(ev, conflicts) {
    if (!conflicts.length) return null;
    const key = (c) => [c.start_time === ev.start_time ? 1 : 0, titleScore(c.title, ev.title)];
    return conflicts.reduce((a, b) => { const ka = key(a), kb = key(b); return kb[0] > ka[0] || (kb[0] === ka[0] && kb[1] > ka[1]) ? b : a; });
  }
  function sortedConflicts(ev, conflicts) {
    const cand = mergeCandidate(ev, conflicts);
    if (!cand) return [conflicts, false];
    return [[cand, ...conflicts.filter((c) => c.id !== cand.id)], cand.start_time === ev.start_time];
  }
  function mergedOf(target, incoming) {
    const fill = {};
    if (!target.start_time && incoming.start_time) { fill.start_time = incoming.start_time; fill.end_time = incoming.end_time; }
    else if (target.start_time && !target.end_time && incoming.end_time && (!incoming.start_time || incoming.start_time === target.start_time) && incoming.end_time > target.start_time) fill.end_time = incoming.end_time;
    if (!target.location && incoming.location) fill.location = incoming.location;
    if (!target.description && incoming.description) fill.description = incoming.description;
    return Object.keys(fill).length ? { ...target, ...fill } : null;
  }
  function applyChangeTo(change, target) {
    change.before = fields(target);
    const updated = change.kind === "cancel" ? { ...target, status: "cancelled" } : updatedEv(target, change);
    updateEvent(updated);
    resolveChange(change, "applied");
    return updated;
  }
  function mergeInto(target, incoming) {
    const merged = mergedOf(target, incoming);
    if (!merged) return [target, null];
    const change = addChange({
      event_id: target.id, kind: "merge", before: fields(target), after: fields(merged), reason: "",
      source: incoming.source, source_message_id: incoming.source_message_id, source_author: incoming.source_author,
      source_channel: incoming.source_channel, source_url: "", raw_text: incoming.raw_text, confidence: incoming.confidence,
    });
    return [applyChangeTo(change, target), change];
  }
  const findSimilar = (ev, statuses) => listEvents({ statuses, onDate: ev.date }).find((e) => timesCompatible(e, ev) && similar(e.title, ev.title)) || null;

  // ---------- 通知 ----------
  const notifier = {
    added: (e) => notify("added", eventLine(e), e.id),
    conflict: (e, cs, likely) => notify("conflict", conflictMessage(e, cs, likely), e.id),
    rejected: (e) => notify("resolved", `追加しませんでした: ${eventLine(e)}`, e.id),
    held: (e) => notify("held", `追加するか確認してください${AUDIENCE_LABELS[e.audience] ? `（${AUDIENCE_LABELS[e.audience]}）` : ""}: ${eventLine(e)}${who(e)}`, e.id),
    skipped: (e) => notify("skipped", `${["others", ""].includes(e.audience) ? "他の人の予定" : `${AUDIENCE_LABELS[e.audience]}の予定`}として見送りました: ${eventLine(e)}${who(e)}`, e.id),
    mergedInto: (e) => notify("resolved", `同じ予定としてまとめました: ${eventLine(e)}`, e.id),
    undone: (c, e) => notify("undone", `元に戻しました: ${eventLine(e)}`, e.id, c.id),
    changed(change, ev) {
      const before = withFields(ev, change.before);
      if (change.kind === "cancel") return notify("cancelled", `${eventLine(before)}を取り消しました`, ev.id, change.id);
      if (change.kind === "merge") return notify("merged", mergedMessage(before, ev), ev.id, change.id);
      return notify("updated", updatedMessage(before, ev), ev.id, change.id);
    },
    changePending(change, ev, conflicts) {
      const after = change.kind === "update" ? updatedEv(ev, change) : null;
      return notify("change_pending", changePendingMessage(change.kind, ev, after, conflicts, change.reason), ev.id, change.id);
    },
    changeRejected(change) {
      const ev = getEvent(change.event_id) || blankEvent({});
      const before = withFields(ev, change.before);
      return notify("resolved", `${change.kind === "cancel" ? "取り消しませんでした" : "変更しませんでした"}: ${eventLine(before)}`, change.event_id, change.id);
    },
    info: (m, id = null) => notify("info", m, id),
  };

  // ---------- 登録 ----------
  function place(ev, { sameAsId = null, existing = false, hold = false } = {}) {
    let same = sameAsId ? getEvent(sameAsId) : null;
    if (!same || !["confirmed", "pending"].includes(same.status)) same = findSame(ev);
    let merged = null, change = null, conflicts = [], likely = false;
    if (same) {
      [merged, change] = mergeInto(same, ev);
      if (existing) setStatus(ev.id, "merged");
    } else {
      if (hold) {
        const declined = findSimilar(ev, ["rejected"]);
        if (declined) return { status: "duplicate", event: declined };
      }
      [conflicts, likely] = sortedConflicts(ev, findConflicts(ev));
      ev.status = conflicts.length || hold ? "pending" : "confirmed";
      ev.held = hold;
      if (existing) { setStatus(ev.id, ev.status); getEvent(ev.id).held = hold; } else addEvent(ev);
    }
    if (same) {
      if (!change) return { status: "duplicate", event: same };
      notifier.changed(change, merged);
      return { status: "merged", event: merged, change };
    }
    if (conflicts.length) { notifier.conflict(ev, conflicts, likely); return { status: "pending", event: ev, conflicts }; }
    if (hold) { notifier.held(ev); return { status: "pending", event: ev }; }
    notifier.added(ev);
    return { status: "added", event: ev };
  }

  function validate(raw, msg) {
    const title = String(raw.title || "").trim().slice(0, 60);
    if (!title || raw.confidence < MIN_CONFIDENCE) return null;
    const d = parseDate(raw.date);
    const today = todayIso();
    if (!d || d < today || d > addDays(today, 730)) return null;
    const start = parseTime(raw.start_time);
    let end = start ? parseTime(raw.end_time) : null;
    if (end && end <= start) end = null;
    return blankEvent({
      title, date: d, start_time: start, end_time: end,
      location: String(raw.location || "").trim().slice(0, 200), description: String(raw.description || "").trim().slice(0, 500),
      source: msg.source, source_message_id: msg.message_id, source_author: msg.author, source_channel: msg.channel,
      raw_text: msg.text.slice(0, 2000), confidence: Math.max(0, Math.min(1, raw.confidence)),
    });
  }

  // ---------- 誰宛てか（本体の audience.py と同じ） ----------
  const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
  const EVERYONE = /@(everyone|here|channel|all|全員)(?![0-9a-z_])/;
  const ASCII_WORD = /^[0-9a-z_.\-]+$/;
  const normalize = (t) => String(t || "").replace(INVISIBLE, "").normalize("NFKC").toLowerCase();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function findTerm(text, terms) {
    const hay = normalize(text);
    if (!hay) return null;
    for (const term of terms) {
      const t = normalize(term).trim().replace(/^@/, "").trim();
      if (!t) continue;
      if (ASCII_WORD.test(t)) { if (new RegExp(`(?<![0-9a-z_])${escapeRe(t)}(?![0-9a-z_])`).test(hay)) return term; }
      else if (hay.includes(t)) return term;
    }
    return null;
  }
  const isDm = (channel) => String(channel || "").trim().endsWith("DM");
  function isMe(author, names) {
    const a = normalize(author).trim();
    if (!a) return false;
    const head = a.split(" (")[0].trim();
    return names.some((n) => { const x = normalize(n).trim().replace(/^@/, ""); return x && (x === a || x === head); });
  }
  function judge(llmAudience, msg, rules, context) {
    const { names, groups } = rules;
    let hit;
    if ((hit = findTerm(msg.text, names))) return ["me", `名前「${hit}」が出てくる`];
    if (isMe(msg.author, names)) return ["me", "自分の発言"];
    if (llmAudience === "others") return ["others", "他の人だけの予定"];
    if (isDm(msg.channel)) return ["me", "DM"];
    if (msg.source === "manual") return ["me", "自分で貼り付けたメッセージ"];
    if ((hit = findTerm(`${msg.text}\n${msg.channel}`, groups))) return ["all", `所属グループ「${hit}」宛て`];
    const m = EVERYONE.exec(normalize(msg.text));
    if (m) return ["all", `${m[0]} 宛て`];
    if (llmAudience === "all") return ["all", "全体への連絡"];
    if (llmAudience === "me") {
      if (context.some((c) => findTerm(c.text, names) || isMe(c.author, names))) return ["me", "直前のやり取りに名前が出てくる"];
      return ["unknown", "名前や DM などの根拠がない"];
    }
    return ["unknown", "名前も所属グループも出てこない"];
  }
  function cleanList(values) {
    const list = Array.isArray(values) ? values : String(values || "").split(/[,、，\n]/);
    const out = [], seen = new Set();
    for (const v0 of list) {
      const v = String(v0).replace(INVISIBLE, "").trim().replace(/^[@＠]/, "").trim().slice(0, 40);
      const key = normalize(v);
      if (v && !seen.has(key)) { seen.add(key); out.push(v); }
    }
    return out.slice(0, 30);
  }

  function addByAudience(ev, raw, msg, context) {
    const [aud, reason] = judge(raw.audience, msg, db.rules, context);
    ev.audience = aud;
    ev.audience_reason = reason;
    const action = db.rules.actions[aud] || "add";
    if (action === "skip") {
      const same = findSimilar(ev, ["skipped"]);
      if (same) return { status: "duplicate", event: same };
      ev.status = "skipped";
      addEvent(ev);
      notifier.skipped(ev);
      return { status: "skipped", event: ev };
    }
    return place(ev, { hold: action === "confirm" });
  }

  function handleSame(raw, msg, candidates, context) {
    const target = raw.target_id ? candidates.find((e) => e.id === raw.target_id) : null;
    if (target && !String(raw.date || "").trim()) raw = { ...raw, date: target.date };
    const ev = validate(raw, msg);
    if (!ev) return null;
    if (target && ev.date === target.date && timesCompatible(target, ev)) return place(ev, { sameAsId: target.id });
    return addByAudience(ev, raw, msg, context);
  }

  // ---------- 変更・取り消し ----------
  const changeCandidates = () => { const t = todayIso(); return listEvents({ statuses: ["confirmed", "pending"], from: t, to: addDays(t, CANDIDATE_DAYS) }).slice(0, CANDIDATE_LIMIT); };
  function resolveTarget(raw, candidates) {
    const tTitle = String(raw.target_title || raw.title || "").trim();
    let tDate = parseDate(raw.target_date);
    if (!tDate && raw.action === "cancel") tDate = parseDate(raw.date);
    const ev = raw.target_id ? candidates.find((e) => e.id === raw.target_id) : null;
    if (ev) {
      const titleOk = tTitle ? similar(ev.title, tTitle) : null;
      const dateOk = tDate ? ev.date === tDate : null;
      const mismatch = (titleOk === false) + (dateOk === false);
      const match = (titleOk === true) + (dateOk === true);
      return [ev, mismatch === 0 || (mismatch === 1 && match === 1)];
    }
    if (!tTitle && !tDate) return [null, false];
    const matches = candidates.filter((e) => (!tDate || e.date === tDate) && (!tTitle || similar(e.title, tTitle)));
    if (!matches.length) return [null, false];
    return [matches[0], matches.length === 1 && !!tTitle && !!tDate];
  }
  function buildUpdate(raw, target) {
    const d = parseDate(raw.date) || target.date;
    const today = todayIso();
    if (d < today || d > addDays(today, 730)) return null;
    const startRaw = String(raw.start_time || "").trim();
    const start = (startRaw ? parseTime(startRaw) : null) || target.start_time;
    let end = String(raw.end_time || "").trim() ? parseTime(raw.end_time) : null;
    if (!end && start) {
      if (start === target.start_time) end = target.end_time;
      else if (target.start_time && target.end_time) {
        const shifted = minutes(start) + (minutes(target.end_time) - minutes(target.start_time));
        end = shifted < 24 * 60 ? hmOf(shifted) : null;
      }
    }
    if (!start || (end && end <= start)) end = null;
    return {
      ...target, date: d, start_time: start, end_time: end,
      location: String(raw.location || "").trim().slice(0, 200) || target.location,
      description: String(raw.description || "").trim().slice(0, 500) || target.description,
    };
  }
  function confirmReason(change, clear, conflicts) {
    if (conflicts.length) return "変更後の日時に別の予定があります";
    if (!clear) return "どの予定のことか確定できませんでした";
    if (change.confidence < CHANGE_AUTO_CONFIDENCE) return "変更内容に自信がないため確認しています";
    return null;
  }
  function submitChange(change, target, clear) {
    for (const p of db.changes.filter((c) => c.status === "pending" && c.event_id === target.id)) {
      if (p.kind === change.kind && JSON.stringify(p.after) === JSON.stringify(change.after)) return { status: "change_pending", event: target, change: p };
    }
    const conflicts = change.kind === "update" ? findConflicts(updatedEv(target, change)) : [];
    const reason = confirmReason(change, clear, conflicts);
    if (reason !== null) change.reason = reason;
    addChange(change);
    if (reason !== null) { notifier.changePending(change, target, conflicts); return { status: "change_pending", event: target, conflicts, change }; }
    const updated = applyChangeTo(change, target);
    notifier.changed(change, updated);
    return { status: change.kind === "update" ? "updated" : "cancelled", event: updated, change };
  }
  function handleChange(raw, msg, candidates) {
    if (raw.confidence < MIN_CONFIDENCE) return [null, ""];
    const [target, clear] = resolveTarget(raw, candidates);
    if (!target) {
      if (raw.action === "update") { const ev = validate(raw, msg); return [ev ? place(ev) : null, ""]; }
      return [null, "取り消し対象の予定が見つかりませんでした"];
    }
    let after = {};
    if (raw.action === "update") {
      const updated = buildUpdate(raw, target);
      if (!updated) return [null, "変更後の日付を解釈できませんでした"];
      after = fields(updated);
      if (JSON.stringify(after) === JSON.stringify(fields(target))) return [{ status: "duplicate", event: target }, ""];
    }
    const change = {
      event_id: target.id, kind: raw.action, before: fields(target), after, reason: "",
      source: msg.source, source_message_id: msg.message_id, source_author: msg.author, source_channel: msg.channel,
      source_url: "", raw_text: msg.text.slice(0, 2000), confidence: Math.max(0, Math.min(1, raw.confidence)),
    };
    return [submitChange(change, target, clear), ""];
  }

  // ---------- 確認待ち ----------
  function pendingItems() {
    const items = [];
    for (const ev of listEvents({ statuses: ["pending"] })) {
      const [others, likely] = sortedConflicts(ev, findConflicts(ev));
      items.push({ kind: "add", event: toDict(ev), conflicts: others.map(toDict), merge_into: others.length ? others[0].id : null, likely_same: likely });
    }
    for (const ch of db.changes.filter((c) => c.status === "pending")) {
      const target = getEvent(ch.event_id);
      if (!target || ["cancelled", "rejected"].includes(target.status)) continue;
      const item = { kind: ch.kind, change: changeDict(ch), event: toDict(target), conflicts: [] };
      if (ch.kind === "update") {
        const after = updatedEv(target, ch);
        item.after = toDict(after);
        item.conflicts = findConflicts(after).map(toDict);
      }
      items.push(item);
    }
    return items;
  }

  // ---------- メッセージの精査 ----------
  const DATE_HINT = /[0-9０-９]|[一二三四五六七八九十]+日|今日|本日|明日|あした|あす|明後日|あさって|今週|来週|再来週|今月|来月|週末|[月火水木金土日]曜|午前|午後|正午|朝|昼|夕方|夜|日程|予定|締切|締め切り|〆切|期限|ミーティング|MTG|mtg|会議|打ち合わせ|打合せ|面談|面接|集合|イベント|飲み会|授業|講義|試験|テスト|中止|延期|キャンセル|取り消|取消|取りやめ|取り止め|変更|リスケ|順延|前倒し|なくなり|無くなり|休講/;
  const FOLLOWUP = /(?<![a-z])ok(?![a-z])|オッケ|おっけ|了解|りょ|承知|かしこまり|それで|そこで|決定|決まり|確定|大丈夫|いいよ|いいね|いいです|賛成|お願いします|よろしく|行けます|いけます|行きます|参加|欠席|行けない|いけない|無理|👍|🙆|⭕|🆗/iu;
  const looksLikeSchedule = (t) => DATE_HINT.test(t || "");
  const threadKey = (msg) => { const base = `${msg.source}|${msg.channel}`; return isDm(msg.channel) ? `${base}|${msg.author}` : base; };
  function contextFor(msg) {
    const list = db.recent[threadKey(msg)] || [];
    const since = Date.now() - CONTEXT_MINUTES * 60000;
    return list.filter((c) => Date.parse(c.sentAt) >= since).slice(-CONTEXT_MESSAGES);
  }
  function remember(msg) {
    const key = threadKey(msg);
    const since = Date.now() - CONTEXT_MINUTES * 2 * 60000;
    const list = (db.recent[key] || []).filter((c) => Date.parse(c.sentAt) >= since);
    list.push({ author: msg.author, text: msg.text.slice(0, 300), sentAt: msg.sentAt });
    db.recent[key] = list.slice(-20);
  }

  // LLM の答えを本体の ExtractedEvent と同じようにゆるく読む
  function cleanRaw(e) {
    const actionAlias = { delete: "cancel", remove: "cancel", change: "update", modify: "update", reschedule: "update", duplicate: "same", reminder: "same", repeat: "same", existing: "same" };
    const audAlias = { self: "me", user: "me", everyone: "all", group: "all", other: "others", someone: "others" };
    let action = String(e.action || "add").trim().toLowerCase();
    action = actionAlias[action] || action;
    let aud = String(e.audience || "unknown").trim().toLowerCase();
    aud = audAlias[aud] || aud;
    const tid = typeof e.target_id === "string" ? parseInt(e.target_id.replace(/^[#＃]/, ""), 10) : Number(e.target_id);
    const str = (v) => (v === null || v === undefined ? "" : String(v));
    return {
      action: ["add", "same", "update", "cancel"].includes(action) ? action : "add",
      audience: ["me", "all", "others", "unknown"].includes(aud) ? aud : "unknown",
      target_id: Number.isFinite(tid) ? tid : 0,
      target_title: str(e.target_title), target_date: str(e.target_date), title: str(e.title), date: str(e.date),
      start_time: str(e.start_time), end_time: str(e.end_time), location: str(e.location), description: str(e.description),
      confidence: Number(e.confidence) || 0,
    };
  }

  async function extract(msg, candidates, context) {
    if (!CONFIG.workerUrl) throw httpError(503, "デモ版の設定（読み取りの中継先）がまだありません");
    let res;
    try {
      res = await realFetch(`${CONFIG.workerUrl.replace(/\/$/, "")}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: msg.text, author: msg.author, channel: msg.channel, sentAt: msg.sentAt,
          existing: candidates.map((e) => ({ id: e.id, date: e.date, start_time: e.start_time, end_time: e.end_time, title: e.title, location: e.location })),
          context: context.map((c) => ({ author: c.author, text: c.text, sentAt: c.sentAt })),
          names: db.rules.names, groups: db.rules.groups,
        }),
      });
    } catch (_) {
      throw httpError(503, "読み取りの中継先につながりませんでした。時間をおいて試してください");
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok) throw httpError(res.status, data.error || "読み取りに失敗しました");
    return (Array.isArray(data.events) ? data.events : []).slice(0, 10).map(cleanRaw);
  }

  async function handleMessage(msg) {
    if (!msg.text.trim()) return { skipped: "本文がありません", queued: false, results: [] };
    const context = contextFor(msg);
    remember(msg);
    const worth = looksLikeSchedule(msg.text) || (FOLLOWUP.test(msg.text) && context.some((c) => looksLikeSchedule(c.text)));
    if (!worth) { save(); return { skipped: "日付や予定に関する表現が見つかりませんでした", queued: false, results: [] }; }
    const candidates = changeCandidates();
    const raws = await extract(msg, candidates, context);
    const results = [], notes = [];
    for (const raw of raws) {
      let res = null;
      if (raw.action === "update" || raw.action === "cancel") {
        const [r, note] = handleChange(raw, msg, candidates);
        res = r;
        if (note) notes.push(note);
      } else if (raw.action === "same") {
        res = handleSame(raw, msg, candidates, context);
      } else {
        const ev = validate(raw, msg);
        res = ev ? addByAudience(ev, raw, msg, context) : null;
      }
      if (res) results.push(res);
    }
    save();
    return { skipped: results.length ? "" : notes[0] || "予定は見つかりませんでした", queued: false, results };
  }
  const resultDict = (r) => ({ status: r.status, event: toDict(r.event), conflicts: (r.conflicts || []).map(toDict), change: r.change ? changeDict(r.change) : null });

  // デモの画面（通知を届ける）から呼ぶ
  async function receiveNotification({ author, channel, text }) {
    lastNotices = [];
    const msg = { source: "winnotify", message_id: `demo-${Date.now()}`, text, sentAt: nowIso(), author, channel };
    const outcome = await handleMessage(msg);
    return { ...outcome, results: outcome.results.map(resultDict), notices: lastNotices.map((n) => ({ ...n })) };
  }

  // ---------- 貼り付け（画面の「＋」） ----------
  const jobs = new Map();
  function submitPaste(text) {
    const id = `paste-${Math.random().toString(16).slice(2, 14)}`;
    jobs.set(id, { id, state: "running" });
    const msg = { source: "manual", message_id: id, text, sentAt: nowIso(), author: "", channel: "貼り付け" };
    handleMessage(msg).then((outcome) => {
      if (!outcome.results.length) notifier.info(`貼り付けたメッセージ: ${outcome.skipped || "予定は見つかりませんでした"}`);
      const dups = outcome.results.filter((r) => r.status === "duplicate").map((r) => r.event);
      if (dups.length) notifier.info(`貼り付けたメッセージ: 既に登録済みの予定でした\n${dups.map(eventLine).join("\n")}`, dups[0].id);
      save();
      jobs.set(id, { id, state: "done", outcome: { ...outcome, results: outcome.results.map(resultDict) } });
    }).catch((e) => jobs.set(id, { id, state: "failed", error: e.message }));
    return { id, state: "running" };
  }

  // ---------- API ----------
  function httpError(status, detail) { const e = new Error(detail); e.status = status; return e; }
  function status() {
    return {
      llm: { available: true, text_model: "demo", vision_model: "demo", runtime: { mode: "demo", state: "running" } },
      connectors: [], pending_count: pendingItems().length, unread_count: db.notifications.filter((n) => !n.read).length,
      today: todayIso(), queue: {}, google: { state: "disabled" }, power: { supported: false },
    };
  }
  function isUndoable(changeId) {
    const c = getChange(changeId);
    if (!c || c.status !== "applied") return false;
    const latest = latestApplied(c.event_id);
    return !!latest && latest.id === c.id && !!getEvent(c.event_id);
  }

  async function route(method, path, query, body) {
    let m;
    const ok = (v) => ({ status: 200, body: v });
    if (method === "GET") {
      if (path === "/api/status") return ok(status());
      if (path === "/api/events") {
        const from = query.get("date_from") || (query.get("include_past") ? null : todayIso());
        return ok(listEvents({ statuses: ["confirmed"], from, to: query.get("date_to") }).map(toDict));
      }
      if (path === "/api/holidays") {
        const from = query.get("date_from"), to = query.get("date_to");
        return ok(Object.entries(window.DEMO_HOLIDAYS || {}).filter(([d]) => d >= from && d <= to).map(([date, name]) => ({ date, name })));
      }
      if (path === "/api/pending") return ok(pendingItems());
      if (path === "/api/notifications") {
        return ok(db.notifications.slice().reverse().slice(0, 100).map((n) => {
          const ev = n.kind === "skipped" && n.event_id ? getEvent(n.event_id) : null;
          return { ...n, undoable: !!(n.change_id && ["updated", "cancelled", "merged"].includes(n.kind) && isUndoable(n.change_id)), adoptable: !!(ev && ev.status === "skipped") };
        }));
      }
      if (path === "/api/settings/audience") return ok({ ...db.rules, labels: AUDIENCE_LABELS });
      if (path === "/api/analyze/jobs") return ok([...jobs.values()].filter((j) => j.state === "running"));
      if ((m = /^\/api\/analyze\/jobs\/(.+)$/.exec(path))) return ok(jobs.get(decodeURIComponent(m[1])) || { id: m[1], state: "unknown" });
    }
    if (method === "DELETE" && (m = /^\/api\/events\/(\d+)$/.exec(path))) {
      const ev = getEvent(m[1]);
      if (!ev) throw httpError(404, "予定が見つかりません");
      db.events = db.events.filter((e) => e.id !== ev.id);
      save();
      return ok({ ok: true });
    }
    if (method === "PUT" && path === "/api/settings/audience") {
      const data = JSON.parse(body || "{}");
      for (const [k, v] of Object.entries(data.actions || {})) if (!(k in AUDIENCE_LABELS) || !ACTIONS.includes(v)) throw httpError(400, `扱いは ${ACTIONS.join(" / ")} のどれかにしてください: ${k}=${v}`);
      if ("names" in data) db.rules.names = cleanList(data.names);
      if ("groups" in data) db.rules.groups = cleanList(data.groups);
      db.rules.actions = { ...db.rules.actions, ...(data.actions || {}) };
      save();
      return ok({ ...db.rules, labels: AUDIENCE_LABELS });
    }
    if (method === "POST") {
      lastNotices = [];
      const done = (v) => { save(); return ok(v); };
      if (path === "/api/events") {
        const b = JSON.parse(body || "{}");
        const title = String(b.title || "").trim();
        if (!title) throw httpError(400, "タイトルを入力してください");
        const start = parseTime(b.start_time || "");
        let end = start ? parseTime(b.end_time || "") : null;
        if (end && end <= start) end = null;
        const ev = blankEvent({ title, date: b.date, start_time: start, end_time: end, location: String(b.location || "").trim(), description: String(b.description || "").trim(), source: "manual", source_message_id: `manual-${Date.now()}` });
        return done(resultDict(place(ev)));
      }
      if ((m = /^\/api\/events\/(\d+)\/(confirm|reject|adopt|merge)$/.exec(path))) {
        const ev = getEvent(m[1]);
        if (!ev) throw httpError(404, "予定が見つかりません");
        if (m[2] === "confirm") { if (ev.status === "pending") { ev.status = "confirmed"; notifier.added(ev); } return done(toDict(ev)); }
        if (m[2] === "reject") { if (ev.status === "pending") { ev.status = "rejected"; notifier.rejected(ev); } return done(toDict(ev)); }
        if (m[2] === "adopt") {
          if (ev.status !== "skipped") throw httpError(409, "この予定は既に処理されています");
          return done(resultDict(place(ev, { existing: true })));
        }
        if (ev.status !== "pending") throw httpError(409, "この予定は既に処理されています");
        const into = query.get("into");
        const target = into ? getEvent(into) : mergeCandidate(ev, findConflicts(ev));
        if (!target || target.id === ev.id || !["confirmed", "pending"].includes(target.status)) throw httpError(409, "まとめる先の予定が見つかりません");
        const [merged, change] = mergeInto(target, ev);
        setStatus(ev.id, "merged");
        if (change) notifier.changed(change, merged); else notifier.mergedInto(merged);
        return done(toDict(merged));
      }
      if ((m = /^\/api\/changes\/(\d+)\/(apply|reject|undo)$/.exec(path))) {
        const ch = getChange(m[1]);
        if (!ch) throw httpError(404, "変更が見つかりません");
        if (m[2] === "apply") {
          if (ch.status === "pending") {
            const target = getEvent(ch.event_id);
            if (!target || ["cancelled", "rejected"].includes(target.status)) resolveChange(ch, "rejected");
            else notifier.changed(ch, applyChangeTo(ch, target));
          }
          return done(changeDict(ch));
        }
        if (m[2] === "reject") { if (ch.status === "pending") { resolveChange(ch, "rejected"); notifier.changeRejected(ch); } return done(changeDict(ch)); }
        if (ch.status !== "applied") throw httpError(409, "この変更は元に戻せません");
        const latest = latestApplied(ch.event_id);
        if (!latest || latest.id !== ch.id) throw httpError(409, "このあとにも変更があるため元に戻せません");
        const target = getEvent(ch.event_id);
        if (!target) throw httpError(404, "予定が見つかりません");
        const restored = withFields(target, ch.before);
        updateEvent(restored);
        resolveChange(ch, "undone");
        notifier.undone(ch, restored);
        return done(toDict(restored));
      }
      if (path === "/api/notifications/read") { db.notifications.forEach((n) => { n.read = true; }); return done({ ok: true }); }
      if (path === "/api/queue/retry") return ok({ retried: 0 });
      if (path === "/api/llm/refresh") return ok(status().llm);
      if (path === "/api/analyze/jobs") {
        const form = body instanceof FormData ? body : new FormData();
        if (form.getAll("images").length) throw httpError(400, "デモ版では画像・PDF は読み取れません（本物のアプリでは読み取れます）。文章だけで試してください");
        const text = String(form.get("text") || "").trim();
        if (!text) throw httpError(400, "メッセージを入力してください");
        if (text.length > 1000) throw httpError(400, "デモ版では 1,000 文字までにしてください");
        return { status: 202, body: submitPaste(text) };
      }
    }
    throw httpError(404, "デモ版では使えない操作です");
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const i = url.pathname.indexOf("/api/");
    if (url.origin !== location.origin || i < 0) return realFetch(input, init);
    const path = url.pathname.slice(i);
    try {
      const { status: code, body } = await route((init.method || "GET").toUpperCase(), path, url.searchParams, init.body);
      return new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ detail: e.message || "エラーが発生しました" }), { status: e.status || 500, headers: { "Content-Type": "application/json" } });
    }
  };

  window.DemoBackend = { receiveNotification, reset, rules: () => ({ ...db.rules }), today: todayIso, dateJa };
})();
