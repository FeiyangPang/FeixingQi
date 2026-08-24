"use strict";

/* ==========================================================
 *  挠痒痒惩罚飞行棋
 *  纯前端单文件逻辑：棋盘生成 / 骰子 / 轮盘 / 计时器 / 音效
 * ========================================================== */

/* ---------------- 工具函数 ---------------- */
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick(items, weightFn) {
  const weights = items.map(weightFn);
  let total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return items.length - 1;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtMin(min) {
  if (min < 1) return Math.round(min * 60) + "秒";
  if (Number.isInteger(min)) return min + "分钟";
  return Math.floor(min) + "分" + Math.round((min % 1) * 60) + "秒";
}

/* ---------------- 音效引擎（WebAudio 合成，无需素材文件） ---------------- */
const AudioFX = {
  ctx: null,
  enabled: true,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur = 0.12, type = "sine", gain = 0.18, delay = 0) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },
  noise(dur = 0.08, gain = 0.1, delay = 0) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start(t);
  },
  tick() { this.tone(880, 0.05, "square", 0.06); },
  step() { this.tone(520 + rand(120), 0.09, "triangle", 0.15); this.noise(0.04, 0.04); },
  wheelTick() { this.tone(1200, 0.03, "square", 0.05); },
  diceRattle() {
    for (let i = 0; i < 9; i++) this.noise(0.05, 0.09, i * 0.09 + Math.random() * 0.03);
  },
  diceLand() { this.tone(220, 0.18, "triangle", 0.25); this.noise(0.1, 0.12); },
  ding() { this.tone(1046, 0.25, "sine", 0.2); this.tone(1568, 0.35, "sine", 0.15, 0.1); },
  success() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, "triangle", 0.18, i * 0.11));
  },
  fail() {
    this.tone(220, 0.3, "sawtooth", 0.15);
    this.tone(155, 0.5, "sawtooth", 0.15, 0.18);
  },
  danger() {
    this.tone(110, 0.6, "sawtooth", 0.2);
    this.tone(104, 0.7, "sawtooth", 0.2, 0.1);
  },
  fanfare() {
    const seq = [523, 523, 523, 659, 784, 784, 1046];
    seq.forEach((f, i) => this.tone(f, 0.28, "triangle", 0.2, i * 0.16));
    seq.forEach((f, i) => this.tone(f / 2, 0.28, "sine", 0.12, i * 0.16));
  },
  magic() {
    [1568, 1318, 1046, 880, 1046, 1318, 1568].forEach((f, i) =>
      this.tone(f, 0.12, "sine", 0.12, i * 0.06));
  },
};

/* ---------------- 游戏内容数据 ---------------- */
const LS_KEY = "tickle_ludo_settings_v1";

const DEFAULT_TOOLS = [
  { name: "手指", cruelty: 1 },
  { name: "羽毛", cruelty: 1 },
  { name: "毛刷", cruelty: 2 },
  { name: "气垫梳", cruelty: 3 },
  { name: "撸猫手套", cruelty: 3 },
];

const CRUELTY_ICON = { 1: "😊", 2: "😈", 3: "💀" };
const LAYER_NAMES = ["1F 温柔层", "2F 残忍层", "3F 地狱层"];

// 各层抽工具时，不同残忍度的权重（越往后越残忍）
const TOOL_WEIGHTS = [
  { 1: 5, 2: 2, 3: 1 },
  { 1: 3, 2: 3, 3: 2 },
  { 1: 1, 2: 3, 3: 5 },
];

// 各层时长轮盘（分钟 + 权重）
const DURATION_WHEELS = [
  [ { v: 1, w: 3 }, { v: 2, w: 3 }, { v: 3, w: 2 }, { v: 4, w: 1 }, { v: 5, w: 1 } ],
  [ { v: 3, w: 3 }, { v: 5, w: 3 }, { v: 8, w: 2 }, { v: 10, w: 2 }, { v: 12, w: 1 } ],
  [ { v: 5, w: 2 }, { v: 8, w: 3 }, { v: 10, w: 3 }, { v: 15, w: 2 }, { v: 20, w: 2 }, { v: 25, w: 1 }, { v: 30, w: 1 } ],
];

const PUNISH_TEMPLATES = [
  { pos: "双手被吊起（或举高不许放下）", part: "腋窝" },
  { pos: "趴下，脚踝被固定", part: "脚心" },
  { pos: "平躺，双手压在身下不许拿出来", part: "肚子和腰侧" },
  { pos: "侧躺被紧紧抱住", part: "膝盖窝和大腿" },
  { pos: "坐好背对对方，不许缩脖子", part: "脖子和耳后" },
  { pos: "脱掉袜子，脚趾被扳住", part: "脚趾缝" },
  { pos: "四肢摊开躺平（可用枕头压住手脚）", part: "全身随机游走" },
];

const CHALLENGES = [
  { name: "忍笑挑战", desc: "被{tool}挠痒{dur}，全程不许笑出声。可以憋、可以扭，但笑出声即失败！" },
  { name: "木头人", desc: "保持一个姿势一动不动，被{tool}挠{dur}。明显移动或躲闪即失败！" },
  { name: "静音模式", desc: "被{tool}挠{dur}，不许发出任何声音（笑声、叫声、求饶通通算失败）！" },
  { name: "高举双手", desc: "双臂高高举起{dur}不许放下，期间腋窝随时会被{tool}偷袭。手放下来即失败！" },
  { name: "脚趾倔强", desc: "被{tool}挠脚心{dur}，脚趾全程不许蜷缩。蜷了即失败！" },
  { name: "脚趾夹夹乐", desc: "脚趾夹住一支笔（或小物件），被{tool}挠脚心{dur}。物件掉落即失败！" },
  { name: "挠痒背诗", desc: "在被{tool}挠痒的同时完整背出一首古诗。背错或卡壳超过5秒即失败（限时{dur}）！" },
  { name: "口算大师", desc: "被{tool}挠痒的同时连续答对5道两位数加减法（对方出题）。答错2次即失败（限时{dur}）！" },
  { name: "闻袜子挑战", desc: "鼻子前放上刚脱下来的袜子，同时被{tool}挠{dur}。必须乖乖闻着保持呼吸，憋气或扭头躲开即失败！" },
  { name: "憋气大师", desc: "深吸一口气憋住，然后被{tool}狂挠。每轮憋气15秒、共3轮，中途笑场漏气即失败（限时{dur}内完成）！" },
  { name: "撒娇模式", desc: "被{tool}挠{dur}，全程必须用最嗲的撒娇语气说话，语气不够嗲即失败（对方裁定）！" },
  { name: "花式求饶", desc: "被{tool}挠{dur}，必须不重样地花式求饶不许停嘴，但绝对不许说「停」字，说了即失败！" },
];

const INTERROGATIONS = [
  "如实说出自己的小名或最羞耻的外号，并让对方连叫3遍！",
  "交出手机，让对方随意翻看相册1分钟（或自选3张照片展示并讲解）！",
  "看着对方的眼睛，大声叫3声「主人」！",
  "用最嗲的声音撒娇说：「我最怕痒了，求你轻一点嘛~」并配合可怜表情！",
  "坦白一件从没告诉过对方的小秘密！",
  "说出自己身上最怕痒的部位，并主动送上来让对方免费试挠10秒！",
];

const SOCK_EVENTS = [
  "🧦 脱掉一只袜子！脚心防御力 -50%……",
  "🧦 脱掉两只袜子！从此光脚上阵，自求多福。",
  "🧦 幸运！允许穿回一只袜子（如果已经光脚的话）。",
  "🧦 由对方亲自帮你脱袜子——动作会很慢，很仪式感……",
];

const REWARDS = [
  { icon: "🛋️", text: "休息5分钟！对方还要给你捏捏肩放松一下。" },
  { icon: "🧃", text: "喝饮料时间！对方去给你倒一杯你喜欢的饮料。" },
  { icon: "🍪", text: "投喂时间！吃点小零食，补充体力再战。" },
  { icon: "🦶", text: "顺风顺水！直接前进2格！", move: 2 },
  { icon: "🛡️", text: "获得免罚护体卡！下一个惩罚格自动失效。", shield: true },
];

const ULTIMATE_TEXT =
  "认输者将被【彻底拘束】（绑好手脚，完全不能反抗），协助者可以使用工具库里的所有工具，挠任何部位、任意时长，直到TA满意为止。求饶无效，认输无效，这一次没有暂停键。";

/* ---------------- 设置（玩家名 & 工具库） ---------------- */
let settings = {
  victim: "宝贝",
  master: "主人",
  tools: DEFAULT_TOOLS.slice(),
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.tools) && s.tools.length) settings = s;
    }
  } catch (e) { /* 忽略损坏的存档 */ }
}

function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
}

function renderToolList() {
  const wrap = $("#tool-list");
  wrap.innerHTML = "";
  settings.tools.forEach((t, i) => {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.innerHTML = `<span class="cruelty">${CRUELTY_ICON[t.cruelty]}</span> ${esc(t.name)}`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "删除";
    del.onclick = () => {
      settings.tools.splice(i, 1);
      saveSettings();
      renderToolList();
    };
    chip.appendChild(del);
    wrap.appendChild(chip);
  });
}

/* ---------------- 棋盘生成 ---------------- */
/* 路径共 54 格，每层 18 格：局部 0 层起点 | 1-16 内容格（顺时针绕环）| 17 中心入口/终点
   0 起点 → 1-16 一层 → 17 入口(自动进) → 18 二层起点 → 19-34 → 35 入口 → 36 三层起点 → 37-52 → 53 终点 */
const TOTAL = 54;
const LAYER_SIZE = 18;
const GOAL = TOTAL - 1;

const CELL_META = {
  start:       { icon: "🚩", label: "起点" },
  punish:      { icon: "🕷️", label: "惩罚" },
  challenge:   { icon: "⚔️", label: "挑战" },
  interrogate: { icon: "🎤", label: "拷问" },
  sock:        { icon: "🧦", label: "袜子" },
  reward:      { icon: "🎁", label: "奖励" },
  reverse:     { icon: "🔄", label: "反杀" },
  portal:      { icon: "🌀", label: "传送" },
  stairs:      { icon: "🪜", label: "入口" },
  goal:        { icon: "🏁", label: "终点" },
};

// 每层 16 个内容格的类型配比（会被打乱）
const LAYER_COMPOSITION = [
  { punish: 5, challenge: 5, interrogate: 2, sock: 1, reward: 2, reverse: 1 },              // 16 格
  { punish: 6, challenge: 4, interrogate: 3, sock: 1, reward: 1, reverse: 1 },              // 16 格
  { punish: 6, challenge: 3, interrogate: 2, sock: 1, reward: 1, reverse: 1, portal: 2 },   // 16 格
];

let board = [];

function buildBoard() {
  board = new Array(TOTAL);
  board[0] = { type: "start", label: "起点" };
  board[17] = { type: "stairs", toLayer: 1 };
  board[18] = { type: "start", label: "二层" };
  board[35] = { type: "stairs", toLayer: 2 };
  board[36] = { type: "start", label: "三层" };
  board[GOAL] = { type: "goal" };

  const ranges = [ [1, 16], [19, 34], [37, 52] ];
  ranges.forEach(([from, to], layer) => {
    const types = [];
    for (const [type, count] of Object.entries(LAYER_COMPOSITION[layer])) {
      for (let i = 0; i < count; i++) types.push(type);
    }
    const mixed = shuffle(types);
    for (let p = from; p <= to; p++) {
      const type = mixed[p - from];
      const cell = { type };
      if (type === "punish") cell.tpl = pick(PUNISH_TEMPLATES);
      if (type === "challenge") cell.tpl = pick(CHALLENGES);
      if (type === "interrogate") cell.tpl = pick(INTERROGATIONS);
      if (type === "sock") cell.tpl = pick(SOCK_EVENTS);
      if (type === "reward") cell.tpl = pick(REWARDS);
      board[p] = cell;
    }
  });
}

const layerOf = (pos) => Math.min(2, Math.floor(pos / LAYER_SIZE));

/* ---------------- 游戏状态 ---------------- */
const state = {
  pos: 0,
  busy: false,
  over: false,
  shield: false,
  shownLayer: 0,
};

/* ---------------- 棋盘渲染 ---------------- */
let tokenEl = null;

/* 顺时针环形布局（6列×5行的外圈，共 17 个环上格 + 1 个中心入口格）：
   局部 0-5 顶行左→右 | 6-9 右列下行 | 10-14 底行右→左 | 15-16 左列上行 | 17 棋盘中心 */
const RING_COORDS = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
  [5, 1], [5, 2], [5, 3], [5, 4],
  [4, 4], [3, 4], [2, 4], [1, 4], [0, 4],
  [0, 3], [0, 2],
];
const CELL_W = 13.2, CELL_H = 16.5, PAD_X = 2.6, PAD_Y = 3;
const STEP_X = (100 - PAD_X * 2 - CELL_W) / 5;
const STEP_Y = (100 - PAD_Y * 2 - CELL_H) / 4;
const LAYER_DECO = ["🌸", "🔥", "💀"];

function renderBoard(layer) {
  state.shownLayer = layer;
  const boardEl = $("#board");
  boardEl.innerHTML = "";
  boardEl.className = "board theme-" + layer;

  const deco = document.createElement("div");
  deco.className = "center-deco";
  deco.innerHTML =
    `<span class="deco-icon">${LAYER_DECO[layer]}</span>` +
    `<span class="deco-name">${LAYER_NAMES[layer]}</span>`;
  boardEl.appendChild(deco);

  for (let local = 0; local < LAYER_SIZE; local++) {
    const pos = layer * LAYER_SIZE + local;
    const cell = board[pos];
    const el = document.createElement("div");
    el.className = `cell type-${cell.type}`;
    el.dataset.pos = pos;
    const meta = CELL_META[cell.type];
    el.innerHTML =
      (local === 17 ? "" : `<span class="cell-num">${local + 1}</span>`) +
      `<span class="cell-icon">${meta.icon}</span>` +
      `<span class="cell-label">${cell.label || meta.label}</span>`;
    if (local === 17) {
      // 中心入口 / 终点
      el.classList.add("center-cell");
      el.style.left = "40.5%";
      el.style.top = "38%";
      el.style.width = "19%";
      el.style.height = "23%";
    } else {
      const [c, r] = RING_COORDS[local];
      el.style.left = PAD_X + c * STEP_X + "%";
      el.style.top = PAD_Y + r * STEP_Y + "%";
      el.style.width = CELL_W + "%";
      el.style.height = CELL_H + "%";
    }
    boardEl.appendChild(el);
  }

  tokenEl = document.createElement("div");
  tokenEl.className = "token";
  tokenEl.textContent = "🐹";
  boardEl.appendChild(tokenEl);

  document.querySelectorAll(".layer-tab").forEach((tab) => {
    tab.classList.toggle("active", Number(tab.dataset.layer) === layer);
  });
  $("#layer-badge").textContent = LAYER_NAMES[layer];

  positionToken(false);
}

function positionToken(hop = true) {
  const cellEl = document.querySelector(`.cell[data-pos="${state.pos}"]`);
  document.querySelectorAll(".cell.current").forEach((c) => c.classList.remove("current"));
  if (!cellEl) { tokenEl.style.display = "none"; return; }
  tokenEl.style.display = "";
  cellEl.classList.add("current");
  const boardEl = $("#board");
  const br = boardEl.getBoundingClientRect();
  const cr = cellEl.getBoundingClientRect();
  tokenEl.style.left = cr.left - br.left + cr.width / 2 - tokenEl.offsetWidth / 2 + "px";
  tokenEl.style.top = cr.top - br.top + cr.height / 2 - tokenEl.offsetHeight / 2 + "px";
  if (hop) {
    tokenEl.classList.remove("hop");
    void tokenEl.offsetWidth;
    tokenEl.classList.add("hop");
  }
}

window.addEventListener("resize", () => { if (tokenEl) positionToken(false); });

/* ---------------- 日志 ---------------- */
function addLog(text, important = false) {
  const log = $("#log");
  const div = document.createElement("div");
  div.className = "log-entry" + (important ? " important" : "");
  div.textContent = text;
  log.prepend(div);
  while (log.children.length > 60) log.lastChild.remove();
}

/* ---------------- 弹窗系统 ---------------- */
const overlay = $("#modal-overlay");
const modalEl = $("#modal");

function closeModal() { overlay.classList.remove("active"); }

/** 自动关闭的提示弹窗（无需点击） */
function showAutoModal(html, ms = 2200) {
  return new Promise((resolve) => {
    modalEl.innerHTML = html;
    overlay.classList.add("active");
    setTimeout(() => { closeModal(); resolve(); }, ms);
  });
}

/**
 * 显示弹窗并等待用户点按钮。
 * buttons: [{text, cls, value}]，resolve 对应 value
 */
function showModal(html, buttons) {
  return new Promise((resolve) => {
    modalEl.innerHTML = html;
    const wrap = document.createElement("div");
    wrap.className = "modal-buttons";
    buttons.forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.cls || "btn-primary");
      btn.innerHTML = b.text;
      btn.onclick = () => {
        AudioFX.tick();
        closeModal();
        resolve(b.value);
      };
      wrap.appendChild(btn);
    });
    modalEl.appendChild(wrap);
    overlay.classList.add("active");
  });
}

function cardHTML({ icon, tag, tagCls, title, desc, sub }) {
  return (
    `<div class="modal-icon">${icon}</div>` +
    (tag ? `<span class="modal-tag ${tagCls}">${tag}</span>` : "") +
    `<h2>${title}</h2>` +
    (desc ? `<p class="modal-desc">${desc}</p>` : "") +
    (sub ? `<p class="modal-sub">${sub}</p>` : "")
  );
}

/* ---------------- 轮盘 ---------------- */
const WHEEL_COLORS = ["#ff5fa2", "#9d6bff", "#5ecbff", "#51e3a4", "#ffd45e", "#ff8f5e", "#e05eff", "#5effd9"];

function drawWheel(ctx, items, rotation, highlight = -1) {
  const size = ctx.canvas.width;
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  const seg = (Math.PI * 2) / items.length;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < items.length; i++) {
    const a0 = rotation + i * seg - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a0 + seg);
    ctx.closePath();
    ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
    if (highlight >= 0 && i !== highlight) ctx.fillStyle = "#3a3a55";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // 文字
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#1a1030";
    ctx.font = "bold 14px 'Microsoft YaHei', sans-serif";
    if (highlight >= 0 && i !== highlight) ctx.fillStyle = "rgba(255,255,255,.4)";
    ctx.fillText(items[i].label, r - 12, 5);
    ctx.restore();
  }
  // 中心圆
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fillStyle = "#241640";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.3)";
  ctx.stroke();
  ctx.fillStyle = "#ffd45e";
  ctx.font = "20px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("🎯", cx, cy + 7);
}

/**
 * 弹出轮盘并旋转，返回选中的 item。
 * items: [{label, value, weight}]
 */
function spinWheel(title, items) {
  return new Promise((resolve) => {
    modalEl.innerHTML =
      `<h2>${title}</h2>` +
      `<div class="wheel-box">` +
      `<div class="wheel-pointer">▲</div>` +
      `<canvas id="wheel-canvas" width="300" height="300"></canvas>` +
      `<p class="modal-sub" id="wheel-status">命运的轮盘开始转动……</p>` +
      `<div id="wheel-result"></div>` +
      `</div>`;
    overlay.classList.add("active");

    const canvas = $("#wheel-canvas");
    const ctx = canvas.getContext("2d");
    const seg = (Math.PI * 2) / items.length;
    const chosen = weightedPick(items, (it) => it.weight || 1);

    // 最终旋转角：让选中扇区中心停在正上方（指针位置）
    const spins = 5 + rand(3);
    const finalRot = spins * Math.PI * 2 - (chosen + 0.5) * seg;
    const duration = 3600 + rand(800);
    const start = performance.now();
    let lastSeg = -1;

    drawWheel(ctx, items, 0);

    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const rot = finalRot * eased;
      drawWheel(ctx, items, rot);
      // 指针下方扇区变化时播放咔哒声
      const pointerSeg = Math.floor((((-rot) % (Math.PI * 2)) + Math.PI * 2) / seg) % items.length;
      if (pointerSeg !== lastSeg) { AudioFX.wheelTick(); lastSeg = pointerSeg; }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        drawWheel(ctx, items, finalRot, chosen);
        AudioFX.ding();
        $("#wheel-status").textContent = "命运已裁决！";
        $("#wheel-result").innerHTML =
          `<div class="result-banner">🎯 ${esc(items[chosen].label)}</div>`;
        // 展示结果后自动进入下一步
        setTimeout(() => { closeModal(); resolve(items[chosen]); }, 1600);
      }
    }
    setTimeout(() => requestAnimationFrame(frame), 500);
  });
}

function spinToolWheel(layer, minCruelty = 1) {
  let pool = settings.tools.filter((t) => t.cruelty >= minCruelty);
  if (!pool.length) pool = settings.tools.slice();
  const items = pool.map((t) => ({
    label: `${CRUELTY_ICON[t.cruelty]}${t.name}`,
    value: t,
    weight: TOOL_WEIGHTS[layer][t.cruelty] || 1,
  }));
  return spinWheel("🧤 抽取挠痒工具", items).then((it) => it.value);
}

function spinDurationWheel(layer, mult = 1) {
  const items = DURATION_WHEELS[layer].map((d) => ({
    label: fmtMin(d.v),
    value: d.v,
    weight: d.w,
  }));
  return spinWheel("⏱️ 抽取时长", items).then((it) => Math.min(30, it.value * mult));
}

/* ---------------- 计时器 ---------------- */
/**
 * 倒计时弹窗。
 * opts: { title, desc, minutes, victimName, canGiveUp, canEarlyFinish, failAddsMinutes }
 * 返回 'done' | 'surrender' | 'early'，failCount 记录中途失败次数
 */
function runTimer(opts) {
  return new Promise((resolve) => {
    let remaining = Math.round(opts.minutes * 60);
    let total = remaining;
    let paused = false;
    let failCount = 0;
    let interval = null;
    let display, bar, status;

    function render() {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      display.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      display.classList.toggle("warning", remaining <= 10 && !paused);
      bar.style.width = (remaining / total) * 100 + "%";
    }

    function stop(result) {
      clearInterval(interval);
      closeModal();
      resolve({ result, failCount });
    }

    function startTicking() {
      clearInterval(interval);
      interval = setInterval(() => {
        if (paused) return;
        remaining--;
        if (remaining <= 10 && remaining > 0) AudioFX.tick();
        if (remaining <= 0) {
          render();
          AudioFX.success();
          stop("done");
          return;
        }
        render();
      }, 1000);
    }

    // 计时器界面可能被"确认认输"弹窗覆盖，因此做成可重建
    function buildUI() {
      modalEl.innerHTML =
        `<div class="modal-icon">⏱️</div>` +
        `<h2>${opts.title}</h2>` +
        `<p class="modal-desc">${opts.desc}</p>` +
        `<div class="timer-display" id="timer-display"></div>` +
        `<div class="timer-bar-wrap"><div class="timer-bar" id="timer-bar" style="width:100%"></div></div>` +
        `<p class="timer-status" id="timer-status">${paused ? "休息中……准备好点「继续」" : "进行中……坚持住！"}</p>` +
        `<div class="modal-buttons" id="timer-buttons"></div>`;
      overlay.classList.add("active");

      display = $("#timer-display");
      bar = $("#timer-bar");
      status = $("#timer-status");
      const btns = $("#timer-buttons");

      if (opts.failAddsMinutes) {
        const failBtn = document.createElement("button");
        failBtn.className = "btn btn-warn";
        const normalText = `😫 撑不住了（+${opts.failAddsMinutes}分钟并休息）`;
        failBtn.textContent = paused ? "▶️ 休息好了，继续" : normalText;
        failBtn.onclick = () => {
          if (paused) {
            paused = false;
            failBtn.textContent = normalText;
            status.textContent = "继续挠！加油坚持！";
            AudioFX.tick();
          } else {
            failCount++;
            remaining += opts.failAddsMinutes * 60;
            total += opts.failAddsMinutes * 60;
            paused = true;
            failBtn.textContent = "▶️ 休息好了，继续";
            status.textContent = `已加时 ${opts.failAddsMinutes} 分钟！休息一下，准备好点「继续」`;
            AudioFX.fail();
            render();
          }
        };
        btns.appendChild(failBtn);
      }

      if (opts.canEarlyFinish) {
        const earlyBtn = document.createElement("button");
        earlyBtn.className = "btn btn-success";
        earlyBtn.textContent = "✅ 提前完成";
        earlyBtn.onclick = () => { AudioFX.ding(); stop("early"); };
        btns.appendChild(earlyBtn);
      }

      const giveUpBtn = document.createElement("button");
      giveUpBtn.className = "btn btn-danger";
      giveUpBtn.textContent = "🏳️ 认输";
      giveUpBtn.onclick = async () => {
        clearInterval(interval);
        const sure = await showModal(
          cardHTML({
            icon: "⚠️", title: "确定认输？",
            desc: "认输将直接触发终极惩罚，没有回头路！",
            sub: ULTIMATE_TEXT,
          }),
          [
            { text: "我再坚持一下", cls: "btn-success", value: false },
            { text: "🏳️ 我认输……", cls: "btn-danger", value: true },
          ]
        );
        if (sure) { resolve({ result: "surrender", failCount }); return; }
        buildUI();
        render();
        startTicking();
      };
      btns.appendChild(giveUpBtn);
    }

    buildUI();
    render();
    startTicking();
  });
}

/* ---------------- 各类格子流程 ---------------- */
const TAGS = {
  punish: ["🕷️ 惩罚格", "tag-punish"],
  challenge: ["⚔️ 挑战格", "tag-challenge"],
  interrogate: ["🎤 拷问格", "tag-interrogate"],
  reward: ["🎁 奖励格", "tag-reward"],
  reverse: ["🔄 反杀格", "tag-reverse"],
};

/** 惩罚完整流程：说明 → 抽工具 → 抽时长 → 倒计时 */
async function punishFlow({ tpl, layer, minCruelty = 1, durMult = 1, prefix = "", victim, master }) {
  victim = victim || settings.victim;
  master = master || settings.master;

  await showAutoModal(
    cardHTML({
      icon: "🕷️", tag: TAGS.punish[0], tagCls: TAGS.punish[1],
      title: prefix ? prefix : "惩罚降临！",
      desc: `${esc(victim)}：<b>${esc(tpl.pos)}</b>，<br>即将被挠 <b>${esc(tpl.part)}</b>！`,
      sub: "命运轮盘启动……",
    }),
    2000
  );

  const tool = await spinToolWheel(layer, minCruelty);
  const minutes = await spinDurationWheel(layer, durMult);

  await showModal(
    cardHTML({
      icon: "😈", tag: TAGS.punish[0], tagCls: TAGS.punish[1],
      title: "最终判决",
      desc: `${esc(victim)} ${esc(tpl.pos)}，<br>被 ${esc(master)} 用 <b>${CRUELTY_ICON[tool.cruelty]}${esc(tool.name)}</b> 挠 <b>${esc(tpl.part)}</b><br>整整 <b>${fmtMin(minutes)}</b>！`,
      sub: "中途撑不住可以喊停，但要加时3分钟，休息后继续。",
    }),
    [{ text: "⏱️ 开始行刑", cls: "btn-danger", value: 1 }]
  );

  const { result, failCount } = await runTimer({
    title: "行刑中",
    desc: `${esc(tool.name)} × ${esc(tpl.part)}`,
    minutes,
    failAddsMinutes: 3,
  });

  if (result === "surrender") { await doSurrender(); return "surrender"; }

  await showModal(
    cardHTML({
      icon: "🎉", title: "刑满释放！",
      desc: failCount > 0
        ? `虽然中途喊停了 ${failCount} 次（共加时 ${failCount * 3} 分钟），但${esc(victim)}还是熬过来了！`
        : `${esc(victim)}一次都没有喊停，太顽强了！`,
    }),
    [{ text: "继续冒险", value: 1 }]
  );
  addLog(`🕷️ ${settings.victim} 完成惩罚：${tool.name}挠${tpl.part} ${fmtMin(minutes)}${failCount ? `（喊停${failCount}次）` : ""}`);
  return "done";
}

async function handlePunish(cell, layer) {
  if (state.shield) {
    state.shield = false;
    AudioFX.magic();
    await showModal(
      cardHTML({
        icon: "🛡️", title: "免罚护体卡生效！",
        desc: "本次惩罚被护体卡挡下，安全通过！",
      }),
      [{ text: "好险好险", value: 1 }]
    );
    addLog("🛡️ 免罚卡抵消了一次惩罚！", true);
    return;
  }
  AudioFX.danger();
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 500);
  await punishFlow({ tpl: cell.tpl, layer });
}

async function handleChallenge(cell, layer) {
  await showAutoModal(
    cardHTML({
      icon: "⚔️", tag: TAGS.challenge[0], tagCls: TAGS.challenge[1],
      title: cell.tpl.name,
      desc: "命运轮盘启动，自动抽取本次挑战的工具和时长……",
      sub: "挑战成功安全通过；失败则触发更残忍的加倍惩罚！",
    }),
    2000
  );

  const tool = await spinToolWheel(layer);
  const minutes = await spinDurationWheel(layer, 0.6);
  const desc = cell.tpl.desc
    .replaceAll("{tool}", `<b>${esc(tool.name)}</b>`)
    .replaceAll("{dur}", `<b>${fmtMin(minutes)}</b>`);

  await showModal(
    cardHTML({
      icon: "⚔️", tag: TAGS.challenge[0], tagCls: TAGS.challenge[1],
      title: cell.tpl.name,
      desc,
      sub: "计时结束后，由双方共同裁定挑战是否成功。",
    }),
    [{ text: "⏱️ 开始挑战", value: 1 }]
  );

  const { result } = await runTimer({
    title: "挑战进行中",
    desc: cell.tpl.name,
    minutes,
    canEarlyFinish: true,
  });
  if (result === "surrender") { await doSurrender(); return; }

  const success = await showModal(
    cardHTML({
      icon: "⚖️", title: "裁决时刻",
      desc: `${esc(settings.master)}裁定：${esc(settings.victim)}的挑战成功了吗？`,
    }),
    [
      { text: "✅ 挑战成功", cls: "btn-success", value: true },
      { text: "❌ 挑战失败", cls: "btn-danger", value: false },
    ]
  );

  if (success) {
    AudioFX.success();
    addLog(`⚔️ ${settings.victim} 挑战「${cell.tpl.name}」成功！`, true);
    await showModal(
      cardHTML({ icon: "🏅", title: "挑战成功！", desc: "顽强的意志！安全通过本格。" }),
      [{ text: "继续前进", value: 1 }]
    );
  } else {
    AudioFX.fail();
    addLog(`⚔️ ${settings.victim} 挑战「${cell.tpl.name}」失败，触发加倍惩罚！`, true);
    await showModal(
      cardHTML({
        icon: "💀", title: "挑战失败……",
        desc: "失败的代价：立刻触发一次<b>更残忍</b>的惩罚（工具至少「残忍」级，时长×1.5）！",
      }),
      [{ text: "认命吧", cls: "btn-danger", value: 1 }]
    );
    await punishFlow({
      tpl: pick(PUNISH_TEMPLATES), layer,
      minCruelty: 2, durMult: 1.5, prefix: "挑战失败惩罚！",
    });
  }
}

async function handleInterrogate(cell, layer) {
  const resist = await showModal(
    cardHTML({
      icon: "🎤", tag: TAGS.interrogate[0], tagCls: TAGS.interrogate[1],
      title: "拷问时间",
      desc: esc(cell.tpl),
      sub: "如实照做即可安全通过；硬挺到底就要接受挠痒拷问，扛过去也算赢！",
    }),
    [
      { text: "😳 如实照做（过关）", cls: "btn-success", value: false },
      { text: "😤 硬挺到底（挨挠）", cls: "btn-danger", value: true },
    ]
  );

  if (!resist) {
    addLog(`🎤 ${settings.victim} 在拷问面前选择了……屈服。`);
    await showModal(
      cardHTML({ icon: "😏", title: "招了就好", desc: "很上道。执行完毕后安全通过。" }),
      [{ text: "羞耻但继续", value: 1 }]
    );
    return;
  }

  addLog(`🎤 ${settings.victim} 选择硬挺，接受挠痒拷问！`, true);
  await showModal(
    cardHTML({
      icon: "😈", title: "敬酒不吃吃罚酒",
      desc: "那就用挠痒撬开你的嘴！扛过整段时间就算你赢，中途招供也可以喊停。",
    }),
    [{ text: "上刑吧", cls: "btn-danger", value: 1 }]
  );
  const r = await punishFlow({
    tpl: pick(PUNISH_TEMPLATES), layer, prefix: "挠痒拷问！",
  });
  if (r !== "surrender") {
    await showModal(
      cardHTML({ icon: "🫡", title: "嘴真硬！", desc: "扛过了拷问，什么都没招。佩服！" }),
      [{ text: "继续前进", value: 1 }]
    );
  }
}

async function handleSock(cell) {
  await showModal(
    cardHTML({ icon: "🧦", title: "袜子事件", desc: esc(cell.tpl) }),
    [{ text: "照做", value: 1 }]
  );
  addLog(`🧦 袜子事件：${cell.tpl.replace("🧦 ", "")}`);
}

async function handleReward(cell) {
  AudioFX.magic();
  await showModal(
    cardHTML({
      icon: cell.tpl.icon, tag: TAGS.reward[0], tagCls: TAGS.reward[1],
      title: "幸运奖励！", desc: esc(cell.tpl.text),
    }),
    [{ text: "太好了！", cls: "btn-success", value: 1 }]
  );
  addLog(`🎁 奖励：${cell.tpl.text}`, true);
  if (cell.tpl.shield) state.shield = true;
  if (cell.tpl.move) {
    if (state.pos >= 36 && state.pos + cell.tpl.move > GOAL) {
      addLog("🦶 前进会越过终点，原地不动。");
    } else {
      const entered = await moveSteps(cell.tpl.move);
      if (!entered) await dispatchCell();
    }
  }
}

async function handleReverse(cell, layer) {
  AudioFX.fanfare();
  await showModal(
    cardHTML({
      icon: "🔄", tag: TAGS.reverse[0], tagCls: TAGS.reverse[1],
      title: "反杀时刻！！",
      desc: `极其稀有的反杀格！<b>${esc(settings.victim)}</b> 反客为主，<br>轮到 <b>${esc(settings.master)}</b> 接受惩罚了！`,
      sub: "先甩骰子决定反杀次数……",
    }),
    [{ text: "🎲 甩骰子", value: 1 }]
  );

  const roll = 1 + rand(6);
  const times = roll <= 2 ? 1 : roll <= 4 ? 2 : 3;
  await showModal(
    cardHTML({
      icon: "🎲", title: `掷出了 ${roll} 点！`,
      desc: `反杀 <b>${times}</b> 次！${esc(settings.master)}，准备受刑吧！`,
    }),
    [{ text: "开始反杀", cls: "btn-danger", value: 1 }]
  );
  addLog(`🔄 反杀发动！${settings.master} 要被挠 ${times} 次！`, true);

  for (let i = 0; i < times; i++) {
    const r = await punishFlow({
      tpl: pick(PUNISH_TEMPLATES), layer,
      prefix: `反杀 第 ${i + 1}/${times} 刀！`,
      victim: settings.master,
      master: settings.victim,
    });
    if (r === "surrender") return;
  }
  await showModal(
    cardHTML({ icon: "😌", title: "反杀结束", desc: "大仇得报，神清气爽。继续冒险！" }),
    [{ text: "继续", value: 1 }]
  );
}

async function handlePortal() {
  AudioFX.danger();
  document.body.classList.add("shake");
  setTimeout(() => document.body.classList.remove("shake"), 500);
  await showModal(
    cardHTML({
      icon: "🌀", tag: "🌀 传送门", tagCls: "tag-danger",
      title: "脚下一空……",
      desc: "地狱层的地板裂开了！你摔回了<b>第二层</b>的同一位置……",
      sub: "刚才的努力，白费了呢。",
    }),
    [{ text: "啊啊啊啊", cls: "btn-danger", value: 1 }]
  );
  state.pos -= LAYER_SIZE;
  addLog(`🌀 踩中传送门！摔回第二层（第 ${state.pos} 格）`, true);
  renderBoard(layerOf(state.pos));
  await sleep(300);
}

async function doSurrender() {
  state.over = true;
  AudioFX.danger();
  await showModal(
    cardHTML({
      icon: "⛓️", tag: "🏳️ 认输", tagCls: "tag-danger",
      title: "终 极 惩 罚",
      desc: ULTIMATE_TEXT,
      sub: `${esc(settings.victim)}，你曾经也是个顽强的冒险家，直到你按下了认输键……`,
    }),
    [{ text: "🔄 重新开始游戏", value: 1 }]
  );
  location.reload();
}

async function doWin() {
  state.over = true;
  AudioFX.fanfare();
  launchConfetti();
  await showModal(
    `<div class="final-screen">` +
    cardHTML({
      icon: "🏆", title: "通关成功！！",
      desc: `<b>${esc(settings.victim)}</b> 穿越了三层挠痒地狱，抵达终点！`,
      sub: `奖励：今晚免受一切惩罚，还可以命令 ${esc(settings.master)} 做一件事（合理范围内）！`,
    }) + `</div>`,
    [{ text: "🔄 再来一局", value: 1 }]
  );
  location.reload();
}

/* ---------------- 掷骰子 & 移动 ---------------- */
function setDiceFace(n) {
  const rotations = {
    1: [0, 0], 2: [90, 0], 3: [0, -90],
    4: [0, 90], 5: [-90, 0], 6: [0, 180],
  };
  const [x, y] = rotations[n];
  $("#dice").style.transform = `rotateX(${x + 720}deg) rotateY(${y + 720}deg)`;
}

async function rollDice() {
  const dice = $("#dice");
  dice.style.transform = "";
  dice.classList.add("shaking");
  AudioFX.diceRattle();
  await sleep(850);
  dice.classList.remove("shaking");
  const n = 1 + rand(6);
  setDiceFace(n);
  await sleep(1100);
  AudioFX.diceLand();
  return n;
}

/**
 * 逐格移动。碰到层间入口（17/35 格）时自动拐进中心进入下一层，
 * 丢弃剩余步数。返回 true 表示本次移动触发了进层。
 */
async function moveSteps(steps) {
  for (let i = 0; i < steps; i++) {
    state.pos++;
    AudioFX.step();
    positionToken(true);
    await sleep(330);

    if (state.pos === 17 || state.pos === 35) {
      await enterNextLayer();
      return true;
    }
  }
  // 落格闪光
  const cellEl = document.querySelector(`.cell[data-pos="${state.pos}"]`);
  if (cellEl) {
    cellEl.classList.add("land-flash");
    setTimeout(() => cellEl.classList.remove("land-flash"), 700);
  }
  await sleep(350);
  return false;
}

/** 从中心入口进入下一层 */
async function enterNextLayer() {
  const nextLayer = layerOf(state.pos) + 1;
  AudioFX.magic();
  await sleep(500);
  await showAutoModal(
    cardHTML({
      icon: "🪜", title: `进入 ${LAYER_NAMES[nextLayer]}！`,
      desc: "拐进棋盘中心，自动登上下一层！<br>奖励：原地休息 2 分钟再继续。",
      sub: nextLayer === 2
        ? "前方是地狱层，工具更残忍、时间更长，做好觉悟……"
        : "下一层的惩罚会明显加重哦。",
    }),
    2600
  );
  state.pos++; // 跳到下一层的层起点
  addLog(`🪜 到达入口，自动进入${LAYER_NAMES[nextLayer]}！`, true);
  renderBoard(nextLayer);
  AudioFX.ding();
  await sleep(400);
}

/** 处理棋子当前所在格子的事件 */
async function dispatchCell() {
  const cell = board[state.pos];
  const layer = layerOf(state.pos);

  if (cell.type === "goal") {
    await doWin();
  } else if (cell.type === "punish") {
    await handlePunish(cell, layer);
  } else if (cell.type === "challenge") {
    await handleChallenge(cell, layer);
  } else if (cell.type === "interrogate") {
    await handleInterrogate(cell, layer);
  } else if (cell.type === "sock") {
    await handleSock(cell);
  } else if (cell.type === "reward") {
    await handleReward(cell);
  } else if (cell.type === "reverse") {
    await handleReverse(cell, layer);
  } else if (cell.type === "portal") {
    await handlePortal();
  }
}

async function onRoll() {
  if (state.busy || state.over) return;
  state.busy = true;
  const rollBtn = $("#btn-roll");
  rollBtn.disabled = true;
  $("#roll-hint").textContent = "";

  const n = await rollDice();
  addLog(`🎲 掷出了 ${n} 点`);

  const remaining = GOAL - state.pos;
  if (state.pos >= 36 && n > remaining) {
    // 只有终点必须正好踩中（前两层碰到入口会自动进入，不存在走过头）
    AudioFX.fail();
    $("#roll-hint").textContent = `😵 走过头了！距终点只剩 ${remaining} 格，原地不动。`;
    addLog(`😵 掷出 ${n} 点但只差 ${remaining} 格，走过头无效！`, true);
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 500);
  } else {
    const entered = await moveSteps(n);
    if (!entered) await dispatchCell();

    const left = GOAL - state.pos;
    if (!state.over && left > 0) {
      $("#roll-hint").textContent = `距离终点还有 ${left} 格${state.shield ? "（🛡️护体中）" : ""}`;
    }
  }

  state.busy = false;
  rollBtn.disabled = state.over;
}

/* ---------------- 彩带 ---------------- */
function launchConfetti() {
  const canvas = $("#confetti-canvas");
  canvas.style.display = "block";
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const ctx = canvas.getContext("2d");
  const colors = ["#ff5fa2", "#9d6bff", "#5ecbff", "#51e3a4", "#ffd45e", "#ff8f5e"];
  const parts = Array.from({ length: 180 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 8,
    h: 8 + Math.random() * 10,
    vy: 2 + Math.random() * 3.5,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.15 + Math.random() * 0.3,
    color: pick(colors),
  }));
  const start = performance.now();
  function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.y * 0.02);
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now - start < 6000) requestAnimationFrame(frame);
    else canvas.style.display = "none";
  }
  requestAnimationFrame(frame);
}

/* ---------------- 初始化 & 事件绑定 ---------------- */
function startGame() {
  const victim = $("#input-victim").value.trim();
  const master = $("#input-master").value.trim();
  if (victim) settings.victim = victim;
  if (master) settings.master = master;
  if (!settings.tools.length) {
    settings.tools = DEFAULT_TOOLS.slice();
    renderToolList();
  }
  saveSettings();

  buildBoard();
  state.pos = 0;
  state.busy = false;
  state.over = false;
  state.shield = false;

  $("#screen-setup").classList.remove("active");
  $("#screen-game").classList.add("active");
  renderBoard(0);
  setDiceFace(1);
  addLog(`🚩 冒险开始！${settings.victim} 踏上了挠痒地狱之旅……祝好运（不）。`, true);
  $("#roll-hint").textContent = `距离终点还有 ${GOAL} 格`;
  AudioFX.ensure();
  AudioFX.magic();
}

function initBgDecor() {
  const decor = $("#bg-decor");
  const icons = ["🪶", "✨", "💫", "🎀", "💕", "⭐", "🫧"];
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("span");
    s.textContent = pick(icons);
    s.style.left = Math.random() * 100 + "%";
    s.style.fontSize = 13 + Math.random() * 22 + "px";
    s.style.animationDuration = 14 + Math.random() * 18 + "s";
    s.style.animationDelay = -Math.random() * 25 + "s";
    decor.appendChild(s);
  }
}

function init() {
  loadSettings();
  initBgDecor();
  $("#input-victim").value = settings.victim === "宝贝" ? "" : settings.victim;
  $("#input-master").value = settings.master === "主人" ? "" : settings.master;
  renderToolList();

  $("#btn-add-tool").onclick = () => {
    const name = $("#input-tool-name").value.trim();
    const cruelty = Number($("#input-tool-cruelty").value);
    if (!name) return;
    if (settings.tools.some((t) => t.name === name)) return;
    settings.tools.push({ name, cruelty });
    $("#input-tool-name").value = "";
    saveSettings();
    renderToolList();
    AudioFX.tick();
  };
  $("#input-tool-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-add-tool").click();
  });

  $("#btn-start").onclick = startGame;
  $("#btn-roll").onclick = onRoll;

  $("#btn-sound").onclick = () => {
    AudioFX.enabled = !AudioFX.enabled;
    $("#btn-sound").textContent = AudioFX.enabled ? "🔊" : "🔇";
    if (AudioFX.enabled) AudioFX.tick();
  };

  $("#btn-surrender").onclick = async () => {
    if (state.over) return;
    const sure = await showModal(
      cardHTML({
        icon: "⚠️", title: "确定认输？",
        desc: "认输将直接触发终极惩罚，没有回头路！",
        sub: ULTIMATE_TEXT,
      }),
      [
        { text: "我再坚持一下", cls: "btn-success", value: false },
        { text: "🏳️ 我认输……", cls: "btn-danger", value: true },
      ]
    );
    if (sure) await doSurrender();
  };
}

document.addEventListener("DOMContentLoaded", init);
