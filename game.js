"use strict";

/* ==========================================================
 *  挠痒痒惩罚飞行棋
 *  纯前端逻辑：按层生成棋盘 / 骰子 / 姿势轮盘 / 三轮盘同抽 / 计时器 / 音效
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
const LS_KEY = "tickle_ludo_settings_v2";
const LS_KEY_V1 = "tickle_ludo_settings_v1";
// 内容库版本：升级时对老存档做一次性内容迁移
const SETTINGS_REV = 4;

const DEFAULT_TOOLS = [
  { name: "手指", cruelty: 1 },
  { name: "羽毛", cruelty: 1 },
  { name: "毛刷", cruelty: 2 },
  { name: "气垫梳", cruelty: 3 },
  { name: "撸猫手套", cruelty: 3 },
  { name: "电动牙刷", cruelty: 3 },
];

// 按名称微调抽中概率：手指更常见，羽毛略少
const NAME_BIAS = { "手指": 1.7, "羽毛": 0.55 };

// 特殊工具：勾选后加入轮盘。抽中则忽略部位，改为打脚心，下数 = 时长(分钟)×2
const SPANK_TOOL = { name: "打脚心", cruelty: 3, spank: true };
const SPANK_HITS_PER_MIN = 2;
const SPANK_FAIL_ADD_HITS = 6;

const DEFAULT_POSTURES = [
  "趴着", "跪坐", "平躺", "站立双手吊起", "驷马束缚", "大字束缚", "足枷", "刑椅",
];

const BODY_PARTS = [
  "腋窝", "脚心", "肚子", "腰侧", "膝盖窝", "大腿根", "脖子和耳后", "脚趾缝", "全身游走",
];

const CRUELTY_ICON = { 1: "😊", 2: "😈", 3: "💀" };
const TIER_NAMES = ["温柔层", "残忍层", "地狱层"];
const TIER_DECO = ["🌸", "🔥", "💀"];

// 各难度档抽工具时，不同残忍度的权重（越往后越残忍）
const TOOL_WEIGHTS = [
  { 1: 5, 2: 2, 3: 1 },
  { 1: 3, 2: 3, 3: 2 },
  { 1: 1, 2: 3, 3: 5 },
];

// 各难度档时长轮盘（分钟 + 权重）
const DURATION_WHEELS = [
  [ { v: 1, w: 3 }, { v: 2, w: 3 }, { v: 3, w: 2 }, { v: 4, w: 1 }, { v: 5, w: 1 } ],
  [ { v: 3, w: 3 }, { v: 5, w: 3 }, { v: 8, w: 2 }, { v: 10, w: 2 }, { v: 12, w: 1 } ],
  [ { v: 5, w: 2 }, { v: 8, w: 3 }, { v: 10, w: 3 }, { v: 15, w: 2 }, { v: 20, w: 2 }, { v: 25, w: 1 }, { v: 30, w: 1 } ],
];

/**
 * 挑战库。desc 用于挠痒，spankDesc 用于抽中「打脚心」时的同义改写
 * （挑战内容不变，只把挠痒换成打脚心）。{spank} = 打脚心 N 下
 */
const DEFAULT_CHALLENGES = [
  { name: "忍笑挑战",
    desc: "被{tool}挠{part}{dur}，全程不许笑出声。可以憋、可以扭，但笑出声即失败！",
    spankDesc: "被{spank}，全程不许笑出声。可以憋、可以扭，但笑出声即失败！" },
  { name: "木头人",
    desc: "保持姿势一动不动，被{tool}挠{part}{dur}。明显移动或躲闪即失败！",
    spankDesc: "保持姿势一动不动，被{spank}。明显移动或躲闪即失败！" },
  { name: "静音模式",
    desc: "被{tool}挠{part}{dur}，不许发出任何声音（笑声、叫声、求饶通通算失败）！",
    spankDesc: "被{spank}，不许发出任何声音（惨叫、求饶通通算失败）！" },
  { name: "高举双手",
    desc: "双臂高高举起{dur}不许放下，期间{part}随时会被{tool}偷袭。手放下来即失败！",
    spankDesc: "双臂高高举起不许放下，全程被{spank}。手放下来即失败！" },
  { name: "脚趾倔强",
    desc: "被{tool}挠脚心{dur}，脚趾全程不许蜷缩。蜷了即失败！",
    spankDesc: "被{spank}，脚趾全程不许蜷缩。蜷了即失败！" },
  { name: "脚趾夹夹乐",
    desc: "脚趾夹住一支笔（或小物件），被{tool}挠脚心{dur}。物件掉落即失败！",
    spankDesc: "脚趾夹住一支笔（或小物件），被{spank}。物件掉落即失败！" },
  { name: "挠痒背诗",
    desc: "在被{tool}挠{part}的同时完整背出一首古诗。背错或卡壳超过5秒即失败（限时{dur}）！",
    spankDesc: "在被{spank}的过程中完整背出一首古诗。背错或卡壳超过5秒即失败！" },
  { name: "口算大师",
    desc: "被{tool}挠{part}的同时连续答对5道两位数加减法（对方出题）。答错2次即失败（限时{dur}）！",
    spankDesc: "在被{spank}的过程中连续答对5道两位数加减法（对方出题）。答错2次即失败！" },
  { name: "闻袜子挑战",
    desc: "鼻子前放上刚脱下来的袜子，同时被{tool}挠{part}{dur}。必须乖乖闻着保持呼吸，憋气或扭头躲开即失败！",
    spankDesc: "鼻子前放上刚脱下来的袜子，同时被{spank}。必须乖乖闻着保持呼吸，憋气或扭头躲开即失败！" },
  { name: "憋气大师",
    desc: "深吸一口气憋住，然后被{tool}狂挠{part}。每轮憋气15秒、共3轮，中途笑场漏气即失败（限时{dur}内完成）！",
    spankDesc: "深吸一口气憋住，然后被{spank}。每轮憋气15秒、共3轮，中途笑场漏气即失败！" },
  { name: "撒娇模式",
    desc: "被{tool}挠{part}{dur}，全程必须用最嗲的撒娇语气说话，语气不够嗲即失败（对方裁定）！",
    spankDesc: "被{spank}，全程必须用最嗲的撒娇语气说话，语气不够嗲即失败（对方裁定）！" },
  { name: "花式求饶",
    desc: "被{tool}挠{part}{dur}，必须不重样地花式求饶不许停嘴，但绝对不许说「停」字，说了即失败！",
    spankDesc: "被{spank}，必须不重样地花式求饶不许停嘴，但绝对不许说「停」字，说了即失败！" },
];

const DEFAULT_INTERROGATIONS = [
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

const REROLL_REWARD = {
  icon: "🎲",
  text: "获得重抽卡！在任何惩罚/挑战的判决出来后，可以用它把工具、部位、时长整套重抽一次。",
  reroll: true,
};

const DEFAULT_REWARDS = [
  { icon: "🛋️", text: "休息5分钟！对方还要给你捏捏肩放松一下。" },
  { icon: "🧃", text: "喝饮料时间！对方去给你倒一杯你喜欢的饮料。" },
  { icon: "🦶", text: "顺风顺水！直接前进2格！", move: 2 },
  { icon: "🛡️", text: "获得免罚护体卡！下一个惩罚格自动失效。", shield: true },
  { ...REROLL_REWARD },
];

const DEFAULT_MINIGAMES = [
  { name: "猜数字", desc: "{master}心里想一个 1~100 的数字，{victim}最多猜 7 次，每次提示「大了/小了」。7 次内猜中即获胜！" },
  { name: "24点", desc: "{master}随机报出 4 个 1~10 的数字，{victim}在 60 秒内用加减乘除算出 24 即获胜（可心算或口述过程）！" },
  { name: "脚心写字猜字", desc: "{master}用手指在{victim}的脚心上一笔一画写一个字，{victim}顶着干扰最多猜 3 次，猜中即获胜！" },
];

const DEFAULT_ULTIMATE =
  "认输者将被【彻底拘束】（绑好手脚，完全不能反抗），协助者可以使用工具库里的所有工具，挠任何部位、任意时长，直到TA满意为止。求饶无效，认输无效，这一次没有暂停键。";

/* ---------------- 设置 ---------------- */
function defaultSettings() {
  return {
    victim: "宝贝",
    master: "主人",
    tools: DEFAULT_TOOLS.map((t) => ({ ...t })),
    postures: DEFAULT_POSTURES.slice(),
    uniquePosture: true,
    massager: true,
    spank: false,
    rev: SETTINGS_REV,
    layers: 3,
    ultimate: DEFAULT_ULTIMATE,
    chalReward: "",
    chalFail: "",
    winReward: "",
    challenges: DEFAULT_CHALLENGES.map((c) => ({ ...c })),
    minigames: DEFAULT_MINIGAMES.map((g) => ({ ...g })),
    interrogations: DEFAULT_INTERROGATIONS.slice(),
    rewards: DEFAULT_REWARDS.map((r) => ({ ...r })),
  };
}

let settings = defaultSettings();

function loadSettings() {
  settings = defaultSettings();
  // 没有存档时按最新版本处理；有存档则以存档里记录的版本为准
  let savedRev = SETTINGS_REV;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === "object") {
        savedRev = Number(s.rev) || 0;
        Object.assign(settings, s);
      }
    } else {
      // 从 v1 存档迁移
      const rawV1 = localStorage.getItem(LS_KEY_V1);
      if (rawV1) {
        savedRev = 0;
        const s1 = JSON.parse(rawV1);
        if (s1 && typeof s1 === "object") {
          if (s1.victim) settings.victim = s1.victim;
          if (s1.master) settings.master = s1.master;
          if (s1.ultimate) settings.ultimate = s1.ultimate;
          if (Array.isArray(s1.tools) && s1.tools.length) {
            settings.tools = s1.tools;
            if (!settings.tools.some((t) => t.name === "电动牙刷")) {
              settings.tools.push({ name: "电动牙刷", cruelty: 3 });
            }
          }
        }
      }
    }
  } catch (e) { /* 忽略损坏的存档 */ }
  if (!Array.isArray(settings.tools) || !settings.tools.length) settings.tools = DEFAULT_TOOLS.map((t) => ({ ...t }));
  if (!Array.isArray(settings.postures) || !settings.postures.length) settings.postures = DEFAULT_POSTURES.slice();
  if (!Array.isArray(settings.challenges)) settings.challenges = DEFAULT_CHALLENGES.map((c) => ({ ...c }));
  if (!Array.isArray(settings.minigames)) settings.minigames = DEFAULT_MINIGAMES.map((g) => ({ ...g }));
  if (!Array.isArray(settings.interrogations)) settings.interrogations = DEFAULT_INTERROGATIONS.slice();
  if (!Array.isArray(settings.rewards)) settings.rewards = DEFAULT_REWARDS.map((r) => ({ ...r }));
  if (typeof settings.winReward !== "string") settings.winReward = "";
  if (typeof settings.uniquePosture !== "boolean") settings.uniquePosture = true;
  settings.layers = Math.min(maxLayersAllowed(), Math.max(MIN_LAYERS, Number(settings.layers) || MIN_LAYERS));

  // 老存档迁移：移除吃东西奖励，补上重抽卡
  if (savedRev < 3) {
    settings.rewards = settings.rewards.filter((r) => !/投喂|零食|吃点/.test(r.text || ""));
    if (!settings.rewards.some((r) => r.reroll)) settings.rewards.push({ ...REROLL_REWARD });
  }
  // 老存档迁移：内置挑战/游戏更新文案以适配打脚心（自定义条目原样保留）
  if (savedRev < 4) {
    settings.challenges = settings.challenges.map((c) => {
      const def = DEFAULT_CHALLENGES.find((d) => d.name === c.name);
      return def ? { ...c, desc: def.desc, spankDesc: def.spankDesc } : c;
    });
    settings.minigames = settings.minigames.map((g) => {
      const def = DEFAULT_MINIGAMES.find((d) => d.name === g.name);
      return def ? { ...g, desc: def.desc } : g;
    });
  }
  if (savedRev < SETTINGS_REV) {
    settings.rev = SETTINGS_REV;
    saveSettings();
  }
}

function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* ---------------- 层数 / 姿势数量的相互约束 ---------------- */
const MIN_LAYERS = 3;
const MAX_LAYERS = 7;

/** 勾选「每层姿势不重复」时，层数不能超过姿势数量 */
function maxLayersAllowed() {
  if (!settings.uniquePosture) return MAX_LAYERS;
  return Math.max(MIN_LAYERS, Math.min(MAX_LAYERS, settings.postures.length));
}

/** 姿势最少保留几个：不重复模式下不能少于层数，否则至少留 1 个 */
function minPosturesAllowed() {
  return settings.uniquePosture ? Math.max(MIN_LAYERS, settings.layers) : 1;
}

/** 把约束同步到滑条上限、当前层数和两处说明文字 */
function refreshLimits() {
  const slider = $("#input-layers");
  const max = maxLayersAllowed();
  slider.max = max;
  settings.layers = Math.min(max, Math.max(MIN_LAYERS, Number(slider.value) || MIN_LAYERS));
  slider.value = settings.layers;
  $("#layers-value").textContent = `${settings.layers} 层`;

  const layersNote = $("#layers-note");
  if (settings.uniquePosture) {
    layersNote.textContent =
      `已勾选「每层姿势不重复」：层数上限 = 姿势数量（当前 ${settings.postures.length} 个），` +
      `范围 ${MIN_LAYERS}~${max} 层。想要更多层就先添加姿势，或取消勾选。`;
    layersNote.className = "field-note warn";
  } else {
    layersNote.textContent = `范围 ${MIN_LAYERS}~${MAX_LAYERS} 层。未勾选姿势不重复，姿势可以重复出现。`;
    layersNote.className = "field-note";
  }

  const postureNote = $("#posture-note");
  if (settings.uniquePosture) {
    postureNote.textContent =
      `不重复模式下姿势数量不能少于层数：当前 ${settings.postures.length} 个 / 至少 ${minPosturesAllowed()} 个。`;
  } else {
    postureNote.textContent = `未勾选时姿势会重复出现，至少保留 1 个即可（当前 ${settings.postures.length} 个）。`;
  }
  postureNote.className = "field-note";
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

function renderPostureList() {
  const wrap = $("#posture-list");
  wrap.innerHTML = "";
  settings.postures.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "tool-chip";
    chip.innerHTML = `🧘 ${esc(p)}`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "删除";
    del.onclick = async () => {
      const min = minPosturesAllowed();
      if (settings.postures.length <= min) {
        AudioFX.fail();
        await showModal(
          cardHTML({
            icon: "🚫", title: "不能再删了",
            desc: settings.uniquePosture
              ? `已勾选「每层姿势不重复」，姿势数量不能少于层数。<br>当前 ${settings.postures.length} 个姿势 / ${settings.layers} 层。`
              : "至少要保留 1 个姿势。",
            sub: settings.uniquePosture
              ? "想继续删除，请先取消勾选「每层姿势不重复」，或把层数调小。"
              : "",
          }),
          [{ text: "知道了", value: 1 }]
        );
        return;
      }
      settings.postures.splice(i, 1);
      saveSettings();
      renderPostureList();
      refreshLimits();
      saveSettings();
    };
    chip.appendChild(del);
    wrap.appendChild(chip);
  });
}

/* ---------------- 棋盘生成（按层生成，进层时才确定内容） ---------------- */
/* 每层 18 格：局部 0 层起点 | 1-16 内容格（顺时针绕环）| 17 中心入口（末层为终点） */
const LAYER_SIZE = 18;
let TOTAL = 54;
let GOAL = 53;

const CELL_META = {
  start:       { icon: "🚩", label: "起点" },
  punish:      { icon: "🕷️", label: "惩罚" },
  challenge:   { icon: "⚔️", label: "挑战" },
  interrogate: { icon: "🎤", label: "拷问" },
  sock:        { icon: "🧦", label: "袜子" },
  reward:      { icon: "🎁", label: "奖励" },
  reverse:     { icon: "🔄", label: "反杀" },
  portal:      { icon: "🌀", label: "传送" },
  minigame:    { icon: "🎯", label: "游戏" },
  massager:    { icon: "📳", label: "按摩仪" },
  stairs:      { icon: "🪜", label: "入口" },
  goal:        { icon: "🏁", label: "终点" },
};

let board = [];

const layerOf = (pos) => Math.floor(pos / LAYER_SIZE);
const tierOf = (layer) => Math.min(2, Math.floor((layer * 3) / state.layers));
const layerName = (layer) => `${layer + 1}F ${TIER_NAMES[tierOf(layer)]}`;

function buildBoard() {
  TOTAL = state.layers * LAYER_SIZE;
  GOAL = TOTAL - 1;
  board = new Array(TOTAL);
  for (let i = 0; i < state.layers; i++) {
    const base = i * LAYER_SIZE;
    board[base] = { type: "start", label: i === 0 ? "起点" : `${i + 1}层` };
    board[base + 17] = i === state.layers - 1 ? { type: "goal" } : { type: "stairs" };
  }
  buildLayerContent(0);
}

/** 进入某层时生成该层 16 个内容格（按摩仪格依赖当前脚上状态） */
function buildLayerContent(layer) {
  const tier = tierOf(layer);
  const isFinal = layer === state.layers - 1;

  const counts = {
    punish: isFinal ? 4 : 5,
    challenge: isFinal ? 3 : 4,
    interrogate: 2,
    sock: 1,
    reward: tier === 0 ? 2 : 1,
    minigame: 1,
  };
  if (layer >= 1) counts.reverse = 1;            // 反杀从第二层开始才有
  if (isFinal) counts.portal = 2;                // 传送门只在最后一层
  if (settings.massager) counts.massager = 1;    // 有按摩仪道具才出现按摩仪格

  // 对应内容库被删空时，该类型格子不再生成
  if (!settings.challenges.length) delete counts.challenge;
  if (!settings.minigames.length) delete counts.minigame;
  if (!settings.interrogations.length) delete counts.interrogate;
  if (!settings.rewards.length) delete counts.reward;

  // 补齐/裁剪到 16 格（只在仍存在的类型之间补）
  let total = Object.values(counts).reduce((s, n) => s + n, 0);
  const fillPool = ["punish"];
  if (counts.challenge) fillPool.push("challenge");
  while (total < 16) { counts[pick(fillPool)]++; total++; }
  while (total > 16) {
    if (counts.punish > 2) counts.punish--;
    else if (counts.challenge > 2) counts.challenge--;
    else if (counts.interrogate > 1) counts.interrogate--;
    else break;
    total--;
  }
  // 每局小幅扰动，让布局更不可预测
  if (counts.challenge) {
    if (Math.random() < 0.5 && counts.punish > 3) { counts.punish--; counts.challenge++; }
    else if (counts.challenge > 3) { counts.challenge--; counts.punish++; }
  }

  const types = [];
  for (const [type, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) types.push(type);
  }
  const mixed = shuffle(types);

  const base = layer * LAYER_SIZE;
  for (let local = 1; local <= 16; local++) {
    const type = mixed[local - 1];
    const cell = { type };
    if (type === "challenge") cell.tpl = pick(settings.challenges);
    if (type === "interrogate") cell.tpl = pick(settings.interrogations);
    if (type === "sock") cell.tpl = pick(SOCK_EVENTS);
    if (type === "reward") cell.tpl = pick(settings.rewards);
    if (type === "minigame") cell.tpl = pick(settings.minigames);
    if (type === "massager") cell.tpl = { mode: state.massagerOn ? "off" : "on" };
    board[base + local] = cell;
  }
}

/* ---------------- 游戏状态 ---------------- */
const state = {
  pos: 0,
  busy: false,
  over: false,
  shield: false,
  rerollCards: 0,
  shownLayer: 0,
  layers: 3,
  massagerOn: false,
  posture: "",
  posturePool: [],
  postureDrawn: [],
};

/* ---------------- 棋盘渲染 ---------------- */
let tokenEl = null;

/* 顺时针环形布局（6列×5行的外圈，共 17 个环上格 + 1 个中心入口格） */
const RING_COORDS = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
  [5, 1], [5, 2], [5, 3], [5, 4],
  [4, 4], [3, 4], [2, 4], [1, 4], [0, 4],
  [0, 3], [0, 2],
];
const CELL_W = 13.2, CELL_H = 16.5, PAD_X = 2.6, PAD_Y = 3;
const STEP_X = (100 - PAD_X * 2 - CELL_W) / 5;
const STEP_Y = (100 - PAD_Y * 2 - CELL_H) / 4;

function renderTabs() {
  const tabs = $("#layer-tabs");
  tabs.innerHTML = "";
  for (let i = 0; i < state.layers; i++) {
    const tab = document.createElement("div");
    tab.className = "layer-tab";
    tab.dataset.layer = i;
    tab.textContent = `${i + 1}F ${TIER_DECO[tierOf(i)]}`;
    tabs.appendChild(tab);
  }
}

function renderBoard(layer) {
  state.shownLayer = layer;
  const tier = tierOf(layer);
  const boardEl = $("#board");
  boardEl.innerHTML = "";
  boardEl.className = "board theme-" + tier;

  const deco = document.createElement("div");
  deco.className = "center-deco";
  deco.innerHTML =
    `<span class="deco-icon">${TIER_DECO[tier]}</span>` +
    `<span class="deco-name">${layerName(layer)}</span>`;
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
  $("#layer-badge").textContent = layerName(layer);

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

function closeModal() { overlay.classList.remove("active"); modalEl.classList.remove("wide"); }

/** 自动关闭的提示弹窗（无需点击） */
function showAutoModal(html, ms = 2200) {
  return new Promise((resolve) => {
    modalEl.classList.remove("wide");
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
    modalEl.classList.remove("wide");
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
  const fontSize = size < 200 ? 11 : size < 260 ? 15 : 16;
  const textOff = size < 200 ? 10 : 14;
  const hubR = size < 200 ? 20 : 28;
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
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#1a1030";
    ctx.font = `bold ${fontSize}px 'Microsoft YaHei', sans-serif`;
    if (highlight >= 0 && i !== highlight) ctx.fillStyle = "rgba(255,255,255,.4)";
    ctx.fillText(items[i].label, r - textOff, fontSize * 0.36);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fillStyle = "#241640";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.3)";
  ctx.stroke();
  ctx.fillStyle = "#ffd45e";
  ctx.font = `${size < 200 ? 16 : 22}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("🎯", cx, cy + (size < 200 ? 6 : 8));
}

/** 单个大轮盘（用于姿势抽取），自动旋转自动关闭 */
function spinWheel(title, items) {
  return new Promise((resolve) => {
    modalEl.innerHTML =
      `<h2>${title}</h2>` +
      `<div class="wheel-box">` +
      `<div class="wheel-pointer">▲</div>` +
      `<canvas class="wheel-canvas" id="wheel-canvas" width="300" height="300"></canvas>` +
      `<p class="modal-sub" id="wheel-status">命运的轮盘开始转动……</p>` +
      `<div id="wheel-result"></div>` +
      `</div>`;
    overlay.classList.add("active");

    const canvas = $("#wheel-canvas");
    const ctx = canvas.getContext("2d");
    const seg = (Math.PI * 2) / items.length;
    const chosen = weightedPick(items, (it) => it.weight || 1);

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
        setTimeout(() => { closeModal(); resolve(items[chosen]); }, 1600);
      }
    }
    setTimeout(() => requestAnimationFrame(frame), 500);
  });
}

/**
 * 多个轮盘同时旋转（省时间）。
 * defs: [{ name, items }]，返回各轮盘选中的 item 数组
 */
function spinWheelsMulti(title, defs) {
  return new Promise((resolve) => {
    modalEl.classList.add("wide");
    let html = `<h2>${title}</h2><div class="wheels-row">`;
    defs.forEach((d, i) => {
      html +=
        `<div class="wheel-box small">` +
        `<div class="wheel-mini-title">${esc(d.name)}</div>` +
        `<div class="wheel-pointer">▲</div>` +
        `<canvas class="wheel-canvas" id="wheel-c${i}" width="250" height="250"></canvas>` +
        `<div class="wheel-mini-result" id="wheel-r${i}"></div>` +
        `</div>`;
    });
    html += `</div><p class="modal-sub" id="wheel-status">三个轮盘同时转动……</p>`;
    modalEl.innerHTML = html;
    overlay.classList.add("active");

    const wheels = defs.map((d, i) => {
      const ctx = $(`#wheel-c${i}`).getContext("2d");
      const chosen = weightedPick(d.items, (it) => it.weight || 1);
      const seg = (Math.PI * 2) / d.items.length;
      const spins = 4 + rand(3);
      return {
        items: d.items, ctx, chosen, seg,
        finalRot: spins * Math.PI * 2 - (chosen + 0.5) * seg,
        duration: 2800 + i * 550 + rand(300),
        done: false,
      };
    });

    wheels.forEach((w) => drawWheel(w.ctx, w.items, 0));
    const start = performance.now();
    let lastSeg = -1;

    function frame(now) {
      let allDone = true;
      wheels.forEach((w, i) => {
        const t = Math.min(1, (now - start) / w.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const rot = w.finalRot * eased;
        if (t < 1) {
          allDone = false;
          drawWheel(w.ctx, w.items, rot);
          if (i === 0) {
            const pointerSeg = Math.floor((((-rot) % (Math.PI * 2)) + Math.PI * 2) / w.seg) % w.items.length;
            if (pointerSeg !== lastSeg) { AudioFX.wheelTick(); lastSeg = pointerSeg; }
          }
        } else if (!w.done) {
          w.done = true;
          drawWheel(w.ctx, w.items, w.finalRot, w.chosen);
          AudioFX.ding();
          $(`#wheel-r${i}`).innerHTML = `<span class="mini-banner">${esc(w.items[w.chosen].label)}</span>`;
        }
      });
      if (!allDone) {
        requestAnimationFrame(frame);
      } else {
        $("#wheel-status").textContent = "命运已裁决！";
        setTimeout(() => { closeModal(); resolve(wheels.map((w) => w.items[w.chosen])); }, 1800);
      }
    }
    setTimeout(() => requestAnimationFrame(frame), 500);
  });
}

function toolItems(tier, minCruelty = 1) {
  const all = settings.spank
    ? settings.tools.concat([{ ...SPANK_TOOL }])
    : settings.tools.slice();
  let pool = all.filter((t) => t.cruelty >= minCruelty);
  if (!pool.length) pool = all.slice();
  return pool.map((t) => ({
    label: `${CRUELTY_ICON[t.cruelty]}${t.name}`,
    value: t,
    weight: (TOOL_WEIGHTS[tier][t.cruelty] || 1) * (NAME_BIAS[t.name] || 1),
  }));
}

/** 按倍率缩放基础时长，取整成好读的数值（上限 30 分钟） */
function scaleMinutes(v, mult) {
  const raw = Math.min(30, v * mult);
  if (raw >= 3) return Math.round(raw);
  return Math.max(0.5, Math.round(raw * 2) / 2);
}

/**
 * 时长轮盘。倍率直接作用在刻度上，保证轮盘显示的就是最终执行时长；
 * 缩放后重复的刻度会合并权重。
 */
function durationItems(tier, mult = 1) {
  const merged = new Map();
  DURATION_WHEELS[tier].forEach((d) => {
    const v = scaleMinutes(d.v, mult);
    merged.set(v, (merged.get(v) || 0) + d.w);
  });
  return [...merged.keys()]
    .sort((a, b) => a - b)
    .map((v) => ({ label: fmtMin(v), value: v, weight: merged.get(v) }));
}

function partItems() {
  return BODY_PARTS.map((p) => ({ label: p, value: p, weight: 1 }));
}

/** 部位 + 工具 + 时长 三轮盘同抽。抽中「打脚心」则忽略部位，改为按下数行刑 */
async function spinTriple(tier, { minCruelty = 1, durMult = 1 } = {}) {
  const [part, tool, dur] = await spinWheelsMulti("🎡 命运三连抽", [
    { name: "🎯 部位", items: partItems() },
    { name: "🧤 工具", items: toolItems(tier, minCruelty) },
    { name: "⏱️ 时长", items: durationItems(tier, durMult) },
  ]);
  const minutes = dur.value;
  const spank = !!tool.value.spank;
  return {
    tool: tool.value,
    part: spank ? "脚心" : part.value,
    minutes,
    spank,
    hits: Math.max(2, Math.round(minutes * SPANK_HITS_PER_MIN)),
  };
}

/** 一句话概括本次判决，用于行内文案和日志 */
function drawSummary(draw) {
  if (draw.spank) return `👋 打脚心 ${draw.hits} 下`;
  return `${draw.tool.name} 挠 ${draw.part} ${fmtMin(draw.minutes)}`;
}

/** 判决卡上的行刑描述 */
function verdictText(draw) {
  if (draw.spank) {
    return `被 <b>👋 打脚心 ${draw.hits} 下</b>！<br>` +
      `<span style="font-size:13px;color:var(--text-dim)">（时长轮盘 ${fmtMin(draw.minutes)} × 2，部位轮盘结果作废）</span>`;
  }
  return `用 <b>${CRUELTY_ICON[draw.tool.cruelty]}${esc(draw.tool.name)}</b> 挠 <b>${esc(draw.part)}</b><br>整整 <b>${fmtMin(draw.minutes)}</b>！`;
}

/**
 * 填充挑战文案。抽中打脚心时优先用挑战自带的 spankDesc（内容不变、挠痒换成打脚心），
 * 自定义挑战没有 spankDesc 时退化为自动改写「用X挠Y」。
 */
function fillChallengeDesc(tpl, draw) {
  const desc = typeof tpl === "string" ? tpl : tpl.desc;
  const spankDesc = typeof tpl === "string" ? "" : tpl.spankDesc;
  const spankPhrase = `<b>👋 打脚心 ${draw.hits} 下</b>`;

  if (draw.spank) {
    if (spankDesc) {
      return spankDesc
        .replaceAll("{spank}", spankPhrase)
        .replaceAll("{hits}", `<b>${draw.hits}</b>`)
        .replaceAll("{dur}", `<b>${draw.hits} 下</b>`);
    }
    return desc
      .replace(/\{tool\}(狂?挠)(\{part\}|脚心|腋窝|肚子)/g, "<b>👋 打脚心</b>")
      .replaceAll("{spank}", spankPhrase)
      .replaceAll("{tool}", "<b>👋 巴掌</b>")
      .replaceAll("{part}", "<b>脚心</b>")
      .replaceAll("{hits}", `<b>${draw.hits}</b>`)
      .replaceAll("{dur}", `<b>${draw.hits} 下</b>`);
  }
  return desc
    .replaceAll("{tool}", `<b>${esc(draw.tool.name)}</b>`)
    .replaceAll("{part}", `<b>${esc(draw.part)}</b>`)
    .replaceAll("{dur}", `<b>${fmtMin(draw.minutes)}</b>`)
    .replaceAll("{spank}", `<b>${esc(draw.tool.name)}</b> 挠 <b>${esc(draw.part)}</b> ${fmtMin(draw.minutes)}`)
    .replaceAll("{hits}", `<b>${fmtMin(draw.minutes)}</b>`);
}

/** 有重抽卡时，允许把整套判决重抽一次 */
async function offerReroll(verdictHtml, goText) {
  const buttons = [];
  if (state.rerollCards > 0) {
    buttons.push({
      text: `🎲 用重抽卡重抽（剩 ${state.rerollCards} 张）`,
      cls: "btn-warn", value: "reroll",
    });
  }
  buttons.push({ text: goText, cls: "btn-danger", value: "go" });
  return showModal(verdictHtml, buttons);
}

/**
 * 抽取某层的固定姿势。只在首次进入该层时抽（传送门回头再进不会重抽），
 * force = true 用于终点走过头后玩家主动要求换姿势。
 * 不重复模式下抽过的姿势会从轮盘上消失。
 */
async function drawPosture(layer, { force = false } = {}) {
  if (!force && state.postureDrawn.includes(layer)) return;
  if (!settings.postures.length) { state.posture = "自由姿势"; return; }

  if (!settings.uniquePosture) {
    state.posturePool = settings.postures.slice();
  } else if (!state.posturePool.length) {
    // 传送门等额外抽取可能提前抽空池子，重新装填时尽量避开当前姿势
    state.posturePool = settings.postures.filter((p) => p !== state.posture);
    if (!state.posturePool.length) state.posturePool = settings.postures.slice();
  }

  const items = state.posturePool.map((p) => ({ label: p, value: p, weight: 1 }));
  const it = await spinWheel(
    force ? "🧘 重新抽取本层姿势" : `🧘 抽取第 ${layer + 1} 层固定姿势`,
    items
  );
  state.posture = it.value;
  if (settings.uniquePosture) {
    const idx = state.posturePool.indexOf(it.value);
    if (idx >= 0) state.posturePool.splice(idx, 1);
  }
  if (!state.postureDrawn.includes(layer)) state.postureDrawn.push(layer);
  $("#posture-badge").textContent = `🧘 ${it.value}`;
  addLog(
    (force ? `🧘 重新抽取姿势：${it.value}` : `🧘 第 ${layer + 1} 层姿势：${it.value}`) +
    `（整层保持${settings.uniquePosture ? "，之后不再出现" : ""}）`,
    true
  );
}

/* ---------------- 计时器 ---------------- */
function runTimer(opts) {
  return new Promise((resolve) => {
    const initialSeconds = Math.round(opts.minutes * 60);
    let remaining = initialSeconds;
    let total = initialSeconds;
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
            sub: "终极惩罚的内容是保密的，认输之后才会揭晓……",
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

      // 小字工具按钮：跳过读秒 / 重新计时（计时出问题时的补救手段）
      const mini = document.createElement("div");
      mini.className = "timer-mini-row";
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-mini";
      skipBtn.textContent = "⏭ 跳过读秒";
      skipBtn.title = "直接视为计时结束";
      skipBtn.onclick = () => { AudioFX.ding(); stop("done"); };
      mini.appendChild(skipBtn);
      const resetBtn = document.createElement("button");
      resetBtn.className = "btn-mini";
      resetBtn.textContent = "🔄 重新计时";
      resetBtn.title = "重置回初始时长重新开始";
      resetBtn.onclick = () => {
        remaining = initialSeconds;
        total = initialSeconds;
        paused = false;
        AudioFX.tick();
        buildUI();
        render();
        status.textContent = "已重新计时，重新开始！";
      };
      mini.appendChild(resetBtn);
      modalEl.appendChild(mini);
    }

    buildUI();
    render();
    startTicking();
  });
}

/**
 * 计数式行刑（打脚心）：按「记一下」累计，达到目标下数即结束。
 * 返回 { result: 'done'|'early'|'surrender', failCount }
 */
function runCounter(opts) {
  return new Promise((resolve) => {
    const initialTarget = opts.count;
    let target = initialTarget;
    let hit = 0;
    let failCount = 0;
    let display, bar, status;

    function render() {
      display.textContent = `${hit} / ${target}`;
      display.classList.toggle("warning", target - hit <= 3);
      bar.style.width = Math.min(100, (hit / target) * 100) + "%";
    }

    function finish(result) {
      closeModal();
      resolve({ result, failCount });
    }

    function buildUI() {
      modalEl.innerHTML =
        `<div class="modal-icon">👋</div>` +
        `<h2>${opts.title}</h2>` +
        `<p class="modal-desc">${opts.desc}</p>` +
        `<div class="timer-display" id="counter-display"></div>` +
        `<div class="timer-bar-wrap"><div class="timer-bar" id="counter-bar" style="width:0%"></div></div>` +
        `<p class="timer-status" id="counter-status">每打一下点一次「记一下」</p>` +
        `<div class="modal-buttons" id="counter-buttons"></div>`;
      overlay.classList.add("active");

      display = $("#counter-display");
      bar = $("#counter-bar");
      status = $("#counter-status");
      const btns = $("#counter-buttons");

      const hitBtn = document.createElement("button");
      hitBtn.className = "btn btn-primary btn-big";
      hitBtn.textContent = "👋 记一下";
      hitBtn.onclick = () => {
        hit++;
        AudioFX.step();
        if (hit >= target) {
          render();
          AudioFX.success();
          finish("done");
          return;
        }
        render();
      };
      btns.appendChild(hitBtn);

      const failBtn = document.createElement("button");
      failBtn.className = "btn btn-warn";
      failBtn.textContent = `😫 躲了/缩脚了（+${SPANK_FAIL_ADD_HITS}下）`;
      failBtn.onclick = () => {
        failCount++;
        target += SPANK_FAIL_ADD_HITS;
        AudioFX.fail();
        status.textContent = `已加罚 ${SPANK_FAIL_ADD_HITS} 下！乖乖伸好脚。`;
        render();
      };
      btns.appendChild(failBtn);

      const giveUpBtn = document.createElement("button");
      giveUpBtn.className = "btn btn-danger";
      giveUpBtn.textContent = "🏳️ 认输";
      giveUpBtn.onclick = async () => {
        const sure = await showModal(
          cardHTML({
            icon: "⚠️", title: "确定认输？",
            desc: "认输将直接触发终极惩罚，没有回头路！",
            sub: "终极惩罚的内容是保密的，认输之后才会揭晓……",
          }),
          [
            { text: "我再坚持一下", cls: "btn-success", value: false },
            { text: "🏳️ 我认输……", cls: "btn-danger", value: true },
          ]
        );
        if (sure) { resolve({ result: "surrender", failCount }); return; }
        buildUI();
        render();
      };
      btns.appendChild(giveUpBtn);

      // 小字工具按钮：跳过计数 / 重新计数
      const mini = document.createElement("div");
      mini.className = "timer-mini-row";
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn-mini";
      skipBtn.textContent = "⏭ 跳过计数";
      skipBtn.title = "直接视为打完";
      skipBtn.onclick = () => { AudioFX.ding(); finish("done"); };
      mini.appendChild(skipBtn);
      const resetBtn = document.createElement("button");
      resetBtn.className = "btn-mini";
      resetBtn.textContent = "🔄 重新计数";
      resetBtn.title = "清零，从头开始数";
      resetBtn.onclick = () => {
        hit = 0;
        target = initialTarget;
        AudioFX.tick();
        buildUI();
        render();
        status.textContent = "已清零，重新开始数！";
      };
      mini.appendChild(resetBtn);
      modalEl.appendChild(mini);
    }

    buildUI();
    render();
  });
}

/** 根据判决自动选择倒计时或计数面板 */
function runPunishment(draw, { title, canEarlyFinish = false }) {
  if (draw.spank) {
    return runCounter({
      title,
      desc: `👋 打脚心 × ${draw.hits} 下`,
      count: draw.hits,
    });
  }
  return runTimer({
    title,
    desc: `${esc(draw.tool.name)} × ${esc(draw.part)}`,
    minutes: draw.minutes,
    failAddsMinutes: canEarlyFinish ? 0 : 3,
    canEarlyFinish,
  });
}

/* ---------------- 各类格子流程 ---------------- */
const TAGS = {
  punish: ["🕷️ 惩罚格", "tag-punish"],
  challenge: ["⚔️ 挑战格", "tag-challenge"],
  interrogate: ["🎤 拷问格", "tag-interrogate"],
  reward: ["🎁 奖励格", "tag-reward"],
  reverse: ["🔄 反杀格", "tag-reverse"],
  minigame: ["🎯 游戏格", "tag-challenge"],
};

/**
 * 惩罚完整流程：预告 → 三轮盘同抽（部位/工具/时长） → 最终判决 → 倒计时
 */
async function punishFlow({ tier, minCruelty = 1, durMult = 1, prefix = "", victim, master, withPosture = true }) {
  victim = victim || settings.victim;
  master = master || settings.master;

  await showAutoModal(
    cardHTML({
      icon: "🕷️", tag: TAGS.punish[0], tagCls: TAGS.punish[1],
      title: prefix ? prefix : "惩罚降临！",
      desc: withPosture
        ? `${esc(victim)}：保持本层姿势【<b>${esc(state.posture)}</b>】，<br>部位、工具、时长三连抽即将开始……`
        : `${esc(victim)}：部位、工具、时长三连抽即将开始……`,
    }),
    2000
  );

  let draw = await spinTriple(tier, { minCruelty, durMult });

  // 判决出来后，被惩罚者可以用重抽卡把整套组合重抽
  while (true) {
    const verdict = cardHTML({
      icon: draw.spank ? "👋" : "😈", tag: TAGS.punish[0], tagCls: TAGS.punish[1],
      title: "最终判决",
      desc: (withPosture ? `${esc(victim)} 以【<b>${esc(state.posture)}</b>】固定，<br>` : `${esc(victim)} `) +
        `被 ${esc(master)} ` + verdictText(draw),
      sub: (draw.spank
        ? `中途躲脚可以加罚 ${SPANK_FAIL_ADD_HITS} 下。`
        : "中途撑不住可以喊停，但要加时3分钟，休息后继续。") +
        (state.massagerOn && withPosture ? "<br>📳 脚心上的按摩仪仍在嗡嗡工作中……" : ""),
    });
    const choice = await offerReroll(verdict, draw.spank ? "👋 开始行刑" : "⏱️ 开始行刑");
    if (choice !== "reroll") break;
    state.rerollCards--;
    updateRollHint();
    addLog(`🎲 ${victim} 用掉一张重抽卡，重抽判决！`, true);
    AudioFX.magic();
    draw = await spinTriple(tier, { minCruelty, durMult });
  }

  const { result, failCount } = await runPunishment(draw, { title: "行刑中" });

  if (result === "surrender") { await doSurrender(); return "surrender"; }

  const extraNote = draw.spank
    ? `（共加罚 ${failCount * SPANK_FAIL_ADD_HITS} 下）`
    : `（共加时 ${failCount * 3} 分钟）`;
  await showModal(
    cardHTML({
      icon: "🎉", title: "刑满释放！",
      desc: failCount > 0
        ? `虽然中途撑不住了 ${failCount} 次${extraNote}，但${esc(victim)}还是熬过来了！`
        : `${esc(victim)}一次都没有喊停，太顽强了！`,
    }),
    [{ text: "继续冒险", value: 1 }]
  );
  addLog(
    `${draw.spank ? "👋" : "🕷️"} ${victim} 完成惩罚：${drawSummary(draw)}` +
    (failCount ? `（${draw.spank ? "加罚" : "喊停"}${failCount}次）` : "")
  );
  return "done";
}

async function handlePunish(cell, tier) {
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
  await punishFlow({ tier });
}

async function handleChallenge(cell, tier) {
  await showAutoModal(
    cardHTML({
      icon: "⚔️", tag: TAGS.challenge[0], tagCls: TAGS.challenge[1],
      title: cell.tpl.name,
      desc: `保持本层姿势【<b>${esc(state.posture)}</b>】，<br>部位、工具、时长三连抽即将开始……`,
      sub: "挑战成功安全通过；失败则接受惩罚！",
    }),
    2000
  );

  let draw = await spinTriple(tier, { durMult: 0.6 });

  while (true) {
    const verdict = cardHTML({
      icon: draw.spank ? "👋" : "⚔️", tag: TAGS.challenge[0], tagCls: TAGS.challenge[1],
      title: cell.tpl.name,
      desc: fillChallengeDesc(cell.tpl, draw),
      sub: `姿势保持【${esc(state.posture)}】。结束后由双方共同裁定挑战是否成功。`,
    });
    const choice = await offerReroll(verdict, draw.spank ? "👋 开始挑战" : "⏱️ 开始挑战");
    if (choice !== "reroll") break;
    state.rerollCards--;
    updateRollHint();
    addLog(`🎲 ${settings.victim} 用掉一张重抽卡，重抽挑战组合！`, true);
    AudioFX.magic();
    draw = await spinTriple(tier, { durMult: 0.6 });
  }

  const { result } = await runPunishment(draw, {
    title: "挑战进行中",
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
      cardHTML({
        icon: "🏅", title: "挑战成功！",
        desc: settings.chalReward
          ? esc(settings.chalReward)
          : "顽强的意志！安全通过本格。",
      }),
      [{ text: "继续前进", value: 1 }]
    );
  } else {
    AudioFX.fail();
    addLog(`⚔️ ${settings.victim} 挑战「${cell.tpl.name}」失败！`, true);
    if (settings.chalFail) {
      // 自定义失败惩罚：直接展示，不再抽轮盘
      await showModal(
        cardHTML({
          icon: "💀", title: "挑战失败……",
          desc: esc(settings.chalFail),
          sub: "执行完毕后继续冒险。",
        }),
        [{ text: "认命执行", cls: "btn-danger", value: 1 }]
      );
    } else {
      await showModal(
        cardHTML({
          icon: "💀", title: "挑战失败……",
          desc: "失败的代价：立刻触发一次<b>更残忍</b>的惩罚（工具至少「残忍」级，时长×1.5）！",
        }),
        [{ text: "认命吧", cls: "btn-danger", value: 1 }]
      );
      await punishFlow({ tier, minCruelty: 2, durMult: 1.5, prefix: "挑战失败惩罚！" });
    }
  }
}

async function handleInterrogate(cell, tier) {
  const resist = await showModal(
    cardHTML({
      icon: "🎤", tag: TAGS.interrogate[0], tagCls: TAGS.interrogate[1],
      title: "拷问时间",
      desc: esc(cell.tpl),
      sub: "如实照做即可安全通过；硬挺到底就要上刑拷问（挠痒或打脚心由轮盘决定），扛过去也算赢！",
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

  addLog(`🎤 ${settings.victim} 选择硬挺，接受上刑拷问！`, true);
  await showModal(
    cardHTML({
      icon: "😈", title: "敬酒不吃吃罚酒",
      desc: "那就动手撬开你的嘴！扛过整段刑罚就算你赢，中途招供也可以喊停。",
    }),
    [{ text: "上刑吧", cls: "btn-danger", value: 1 }]
  );
  const r = await punishFlow({ tier, prefix: "拷问上刑！" });
  if (r !== "surrender") {
    await showModal(
      cardHTML({ icon: "🫡", title: "嘴真硬！", desc: "扛过了拷问，什么都没招。佩服！" }),
      [{ text: "继续前进", value: 1 }]
    );
  }
}

async function handleMinigame(cell, tier) {
  const desc = cell.tpl.desc
    .replaceAll("{master}", `<b>${esc(settings.master)}</b>`)
    .replaceAll("{victim}", `<b>${esc(settings.victim)}</b>`);

  await showAutoModal(
    cardHTML({
      icon: "🎯", tag: TAGS.minigame[0], tagCls: TAGS.minigame[1],
      title: cell.tpl.name,
      desc: `保持本层姿势【<b>${esc(state.posture)}</b>】。<br>先抽出玩游戏时的「干扰」：部位、工具、时长三连抽……`,
      sub: "边被折腾边玩，赢了继续前进！",
    }),
    2000
  );

  let draw = await spinTriple(tier, { durMult: 0.6 });

  while (true) {
    const interference = draw.spank
      ? `👋 干扰：全程被 <b>打脚心 ${draw.hits} 下</b>，边被打边玩！`
      : `🪶 干扰：全程被 <b>${CRUELTY_ICON[draw.tool.cruelty]}${esc(draw.tool.name)}</b> 挠 <b>${esc(draw.part)}</b>（共 <b>${fmtMin(draw.minutes)}</b>），边被挠边玩！`;
    const verdict = cardHTML({
      icon: draw.spank ? "👋" : "🎯", tag: TAGS.minigame[0], tagCls: TAGS.minigame[1],
      title: cell.tpl.name,
      desc: `${desc}<br><br>${interference}`,
      sub: "赢了继续飞行棋；输了接受一次完整的三连抽惩罚！",
    });
    const choice = await offerReroll(verdict, draw.spank ? "👋 开始游戏" : "⏱️ 开始游戏");
    if (choice !== "reroll") break;
    state.rerollCards--;
    updateRollHint();
    addLog(`🎲 ${settings.victim} 用掉一张重抽卡，重抽游戏干扰组合！`, true);
    AudioFX.magic();
    draw = await spinTriple(tier, { durMult: 0.6 });
  }

  const { result } = await runPunishment(draw, {
    title: `游戏进行中：${esc(cell.tpl.name)}`,
    canEarlyFinish: true,
  });
  if (result === "surrender") { await doSurrender(); return; }

  const win = await showModal(
    cardHTML({
      icon: "⚖️", title: "裁决时刻",
      desc: `${esc(settings.master)}裁定：${esc(settings.victim)}在「${esc(cell.tpl.name)}」中赢了吗？`,
    }),
    [
      { text: "🏆 我赢了", cls: "btn-success", value: true },
      { text: "💀 我输了", cls: "btn-danger", value: false },
    ]
  );

  if (win) {
    AudioFX.success();
    addLog(`🎯 ${settings.victim} 顶着「${drawSummary(draw)}」的干扰赢下了「${cell.tpl.name}」！`, true);
    await showModal(
      cardHTML({ icon: "🏆", title: "旗开得胜！", desc: "游戏获胜，安全通过本格！" }),
      [{ text: "继续前进", value: 1 }]
    );
  } else {
    AudioFX.fail();
    addLog(`🎯 ${settings.victim} 在「${cell.tpl.name}」中落败，接受惩罚！`, true);
    await punishFlow({ tier, prefix: "游戏失败惩罚！" });
  }
}

async function handleMassager(cell) {
  const mode = cell.tpl.mode;
  if (mode === "on") {
    if (state.massagerOn) {
      await showModal(
        cardHTML({ icon: "📳", title: "按摩仪已就位", desc: "脚心上已经绑着一个按摩仪了，检查一下电量，继续走！" }),
        [{ text: "嗡嗡嗡……", value: 1 }]
      );
      return;
    }
    state.massagerOn = true;
    AudioFX.danger();
    await showModal(
      cardHTML({
        icon: "📳", tag: TAGS.punish[0], tagCls: TAGS.punish[1],
        title: "按摩仪上脚！",
        desc: `${esc(settings.master)} 把按摩仪牢牢固定在 ${esc(settings.victim)} 的<b>脚心</b>上并打开开关！`,
        sub: "在抽到「取下按摩仪」格之前，它会一直嗡嗡作响地陪你走完接下来的路……",
      }),
      [{ text: "😖 接受命运", cls: "btn-danger", value: 1 }]
    );
    addLog("📳 按摩仪固定在脚心上了！", true);
  } else {
    if (!state.massagerOn) {
      await showModal(
        cardHTML({ icon: "📳", title: "空欢喜一场", desc: "脚上并没有按摩仪，这个格子对你无效。继续走吧！" }),
        [{ text: "继续", value: 1 }]
      );
      return;
    }
    state.massagerOn = false;
    AudioFX.magic();
    await showModal(
      cardHTML({
        icon: "🕊️", tag: TAGS.reward[0], tagCls: TAGS.reward[1],
        title: "解脱时刻！",
        desc: "终于可以取下脚心上的按摩仪了，脚底恢复清净……",
      }),
      [{ text: "呼——舒服了", cls: "btn-success", value: 1 }]
    );
    addLog("🕊️ 按摩仪取下了，脚底重获自由！", true);
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
  if (cell.tpl.reroll) { state.rerollCards++; updateRollHint(); }
  if (cell.tpl.move) {
    if (layerOf(state.pos) === state.layers - 1 && state.pos + cell.tpl.move > GOAL) {
      addLog("🦶 前进会越过终点，原地不动。");
    } else {
      const entered = await moveSteps(cell.tpl.move);
      if (!entered) await dispatchCell();
    }
  }
}

async function handleReverse(cell, tier) {
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
      tier,
      prefix: `反杀 第 ${i + 1}/${times} 刀！`,
      victim: settings.master,
      master: settings.victim,
      withPosture: false,
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
      desc: "地板裂开了！你摔回了<b>上一层</b>的同一位置……",
      sub: `刚才的努力，白费了呢。（姿势保持不变，仍是【${esc(state.posture)}】）`,
    }),
    [{ text: "啊啊啊啊", cls: "btn-danger", value: 1 }]
  );
  state.pos -= LAYER_SIZE;
  const backLayer = layerOf(state.pos);
  addLog(`🌀 踩中传送门！摔回第 ${backLayer + 1} 层（姿势不变）`, true);
  renderBoard(backLayer);
  await sleep(300);
}

async function doSurrender() {
  state.over = true;
  AudioFX.danger();
  await showModal(
    cardHTML({
      icon: "⛓️", tag: "🏳️ 认输", tagCls: "tag-danger",
      title: "终 极 惩 罚",
      desc: esc(settings.ultimate).replaceAll("\n", "<br>"),
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
  const rewardText = (settings.winReward || "").trim();
  await showModal(
    `<div class="final-screen">` +
    cardHTML({
      icon: "🏆", title: "通关成功！！",
      desc: `<b>${esc(settings.victim)}</b> 穿越了 ${state.layers} 层挠痒地狱，抵达终点！`,
      sub: rewardText
        ? `🏆 终极奖励：${esc(rewardText).replaceAll("\n", "<br>")}`
        : "恭喜通关！（未设置额外终极奖励）",
    }) + `</div>`,
    [{ text: "🔄 再来一局", value: 1 }]
  );
  location.reload();
}

/* ---------------- 图鉴 ---------------- */
const DEX_CELLS = [
  ["start", "起点 / 层起点", "每层的出发格，安全无事件。"],
  ["punish", "惩罚格", "部位、工具、时长三个轮盘同时开抽，以本层固定姿势被挠。中途撑不住喊停 = 加时3分钟，休息后继续。层数越高，残忍工具概率越大、时长越长（最长30分钟）。若开局勾选了「打脚心」并抽中它，则忽略部位改为打脚心，下数 = 时长分钟数×2。持有重抽卡时，判决出来后可以整套重抽。"],
  ["challenge", "挑战格", "同样三连抽后进行挑战。成功安全通过；失败默认触发加倍惩罚（工具至少「残忍」级、时长×1.5），奖惩均可在开局前自定义。"],
  ["interrogate", "拷问格", "如实招供/照做即可过关；选择硬挺则接受三连抽上刑拷问（挠痒或打脚心），扛过全程也算赢。"],
  ["minigame", "游戏格", "猜数字 / 24点 / 脚心写字猜字。开局先三连抽出「干扰」——边被挠（或边被打脚心）边玩游戏。赢了继续飞行棋，输了再接受一次完整的三连抽惩罚。"],
  ["massager", "按摩仪格", "「固定」：把按摩仪绑上脚心一直嗡嗡作响；「取下」：解脱！只有脚上有按摩仪时取下格才有效。（需在开局前勾选道具）"],
  ["sock", "袜子格", "脱袜子/穿袜子等小事件，影响接下来脚部的「防御力」。"],
  ["reward", "奖励格", "休息、喝饮料、前进2格、免罚护体卡、重抽卡等好事，越往后越稀少。重抽卡可以在判决出来后把工具、部位、时长整套重抽。"],
  ["reverse", "反杀格", "第二层起才会出现！被惩罚者反客为主，甩骰子决定次数（1~3次），反过来挠协助者。"],
  ["portal", "传送门", "仅最后一层出现。踩中直接摔回上一层的同一位置，姿势保持不变；之后重新爬回来也不会换姿势。"],
  ["stairs", "层间入口", "位于棋盘中心。碰到就自动进入下一层（不会走过头）。只有<b>首次</b>进入某层才抽该层姿势，回头再进沿用原姿势。"],
  ["goal", "终点", "只在最后一层出现，必须正好踩中，走过头原地不动（每次走过头都可以选择要不要重新抽姿势）。通关奖励可在初始页自定义，默认无。"],
];

function dexReplace(s) {
  return esc(s)
    .replaceAll("{tool}", "〔轮盘工具〕")
    .replaceAll("{part}", "〔轮盘部位〕")
    .replaceAll("{dur}", "〔轮盘时长〕")
    .replaceAll("{master}", "协助者")
    .replaceAll("{victim}", "被惩罚者");
}

function dexEditableItem(kind, i, innerHtml) {
  return (
    `<div class="dex-item editable">` +
    `<span class="dex-body">${innerHtml}</span>` +
    `<button type="button" class="dex-del" data-del="${kind}" data-i="${i}" title="删除">✕</button>` +
    `</div>`
  );
}

function buildDexHtml() {
  const cellRows = DEX_CELLS.map(([type, name, desc]) =>
    `<div class="dex-item dex-cell"><span class="dex-ico">${CELL_META[type].icon}</span><span><b>${name}</b>：${desc}</span></div>`
  ).join("");
  const postureRows =
    `<div class="dex-item">${settings.postures.map(esc).join(" ｜ ") || "（空）"}</div>` +
    `<div class="dex-item">${settings.uniquePosture
      ? `🚫 已开启<b>每层姿势不重复</b>：抽过的姿势会从轮盘上消失，因此层数上限 = 姿势数量（当前 ${settings.postures.length} 个）。`
      : "🔁 未开启每层姿势不重复：同一个姿势可能在多层重复出现。"}</div>`;
  const partRows = `<div class="dex-item">${BODY_PARTS.map(esc).join(" ｜ ")}</div>`;

  const chalRows = settings.challenges.length
    ? settings.challenges.map((c, i) =>
        dexEditableItem("challenges", i, `<b>${esc(c.name)}</b>：${dexReplace(c.desc)}`)
      ).join("")
    : `<div class="dex-item">（已清空，棋盘上不会再出现挑战格）</div>`;
  const gameRows = settings.minigames.length
    ? settings.minigames.map((g, i) =>
        dexEditableItem("minigames", i, `<b>${esc(g.name)}</b>：${dexReplace(g.desc)}`)
      ).join("")
    : `<div class="dex-item">（已清空，棋盘上不会再出现游戏格）</div>`;
  const interRows = settings.interrogations.length
    ? settings.interrogations.map((t, i) =>
        dexEditableItem("interrogations", i, esc(t))
      ).join("")
    : `<div class="dex-item">（已清空，棋盘上不会再出现拷问格）</div>`;
  const rewardRows = settings.rewards.length
    ? settings.rewards.map((r, i) =>
        dexEditableItem("rewards", i, `${r.icon || "🎁"} ${esc(r.text)}`)
      ).join("")
    : `<div class="dex-item">（已清空，棋盘上不会再出现奖励格）</div>`;
  const sockRows = SOCK_EVENTS.map((t) => `<div class="dex-item">${esc(t)}</div>`).join("");

  return (
    `<div class="modal-icon">📖</div><h2>格子图鉴</h2>` +
    `<p class="modal-sub">下面带 ✕ 的条目都可以删掉，也可以在各库底部添加你们自己的玩法。改动会立刻保存。</p>` +
    `<div class="dex">` +
    `<h3>🗺️ 格子总览</h3>${cellRows}` +
    `<h3>🧘 姿势库（每层抽一次，整层保持）</h3>${postureRows}` +
    `<h3>🎯 部位库（每次惩罚/挑战抽取）</h3>${partRows}` +
    `<h3>⚔️ 挑战库 <span class="dex-hint">可用 {tool} {part} {dur} 代表轮盘结果；抽到打脚心会自动改写文案</span></h3>` +
    `${chalRows}` +
    `<div class="dex-add-row">` +
    `<input id="dex-chal-name" placeholder="挑战名称" maxlength="16">` +
    `<input id="dex-chal-desc" placeholder="规则说明，例如：被{tool}挠{part}{dur}不许笑" maxlength="120">` +
    `<button type="button" class="btn btn-small" data-add="challenges">添加</button>` +
    `</div>` +
    `<h3>🎯 游戏格玩法 <span class="dex-hint">可用 {master} {victim}；游戏全程会有三连抽的干扰</span></h3>` +
    `${gameRows}` +
    `<div class="dex-add-row">` +
    `<input id="dex-game-name" placeholder="游戏名称" maxlength="16">` +
    `<input id="dex-game-desc" placeholder="玩法说明，赢了过关、输了受罚" maxlength="120">` +
    `<button type="button" class="btn btn-small" data-add="minigames">添加</button>` +
    `</div>` +
    `<h3>🎤 拷问库</h3>` +
    `${interRows}` +
    `<div class="dex-add-row">` +
    `<input id="dex-inter-text" placeholder="新的拷问内容" maxlength="80">` +
    `<button type="button" class="btn btn-small" data-add="interrogations">添加</button>` +
    `</div>` +
    `<h3>🧦 袜子事件</h3>${sockRows}` +
    `<h3>🎁 奖励库</h3>` +
    `${rewardRows}` +
    `<div class="dex-add-row">` +
    `<input id="dex-reward-text" placeholder="新的奖励内容" maxlength="80">` +
    `<button type="button" class="btn btn-small" data-add="rewards">添加</button>` +
    `</div>` +
    `<h3>📈 难度规则</h3>` +
    `<div class="dex-item">层数可选 3~7 层，难度分三档随层数递进：温柔档时长 1~5 分钟；残忍档 3~12 分钟；地狱档 5~30 分钟且极刑工具概率最高。「手指」出现概率被调高，「羽毛」略微调低。</div>` +
    `<div class="dex-item">👋 <b>打脚心</b>（需在开局勾选）：所有会转工具轮盘的地方都可能抽到（惩罚、挑战、游戏干扰、拷问、反杀、失败加罚）。抽中后忽略部位轮盘，直接打脚心，下数 = 时长分钟数 × 2，行刑面板改为点击计数；中途躲脚加罚 ${SPANK_FAIL_ADD_HITS} 下。挑战和游戏的内容不变，只是把「挠痒」换成「打脚心」。</div>` +
    `<div class="dex-item">🎲 <b>重抽卡</b>：来自奖励格，可累积。惩罚或挑战的判决出来后，被惩罚的一方可以用掉一张，把工具、部位、时长整套重抽（觉得时间太长就靠它翻盘）。</div>` +
    `</div>`
  );
}

function bindDexEditors() {
  modalEl.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.del;
      const i = Number(btn.dataset.i);
      if (!Array.isArray(settings[kind])) return;
      settings[kind].splice(i, 1);
      saveSettings();
      AudioFX.tick();
      fillDex();
    };
  });
  modalEl.querySelectorAll("[data-add]").forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.add;
      if (kind === "challenges") {
        const name = ($("#dex-chal-name")?.value || "").trim();
        const desc = ($("#dex-chal-desc")?.value || "").trim();
        if (!name || !desc) return;
        settings.challenges.push({ name, desc });
      } else if (kind === "minigames") {
        const name = ($("#dex-game-name")?.value || "").trim();
        const desc = ($("#dex-game-desc")?.value || "").trim();
        if (!name || !desc) return;
        settings.minigames.push({ name, desc });
      } else if (kind === "interrogations") {
        const text = ($("#dex-inter-text")?.value || "").trim();
        if (!text) return;
        settings.interrogations.push(text);
      } else if (kind === "rewards") {
        const text = ($("#dex-reward-text")?.value || "").trim();
        if (!text) return;
        settings.rewards.push({ icon: "🎁", text });
      } else return;
      saveSettings();
      AudioFX.ding();
      fillDex();
    };
  });
  modalEl.querySelectorAll(".dex-add-row input").forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inp.parentElement.querySelector("[data-add]")?.click();
    });
  });
}

function fillDex() {
  modalEl.innerHTML = buildDexHtml() +
    `<div class="modal-buttons"><button type="button" class="btn btn-primary" id="btn-dex-close">关闭图鉴</button></div>`;
  bindDexEditors();
  $("#btn-dex-close").onclick = () => { AudioFX.tick(); closeModal(); };
}

function showDex() {
  modalEl.classList.add("wide");
  overlay.classList.add("active");
  fillDex();
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
 * 逐格移动。碰到层间入口时自动拐进中心进入下一层，
 * 丢弃剩余步数。返回 true 表示本次移动触发了进层。
 */
async function moveSteps(steps) {
  for (let i = 0; i < steps; i++) {
    state.pos++;
    AudioFX.step();
    positionToken(true);
    await sleep(330);

    if (state.pos % LAYER_SIZE === 17 && state.pos !== GOAL) {
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

/** 从中心入口进入下一层：生成新层内容 + 抽取新层姿势 */
async function enterNextLayer() {
  const nextLayer = layerOf(state.pos) + 1;
  AudioFX.magic();
  await sleep(500);
  await showAutoModal(
    cardHTML({
      icon: "🪜", title: `进入 ${layerName(nextLayer)}！`,
      desc: "拐进棋盘中心，自动登上下一层！<br>奖励：原地休息 2 分钟再继续。",
      sub: state.postureDrawn.includes(nextLayer)
        ? `这层来过了，姿势沿用【${esc(state.posture)}】不变。`
        : tierOf(nextLayer) === 2
          ? "这里是地狱档，工具更残忍、时间更长，做好觉悟……"
          : "接下来的惩罚会逐渐加重哦。",
    }),
    2600
  );
  buildLayerContent(nextLayer);
  state.pos++; // 跳到下一层的层起点
  addLog(`🪜 到达入口，自动进入${layerName(nextLayer)}！`, true);
  renderBoard(nextLayer);
  AudioFX.ding();
  await sleep(400);
  await drawPosture(nextLayer);
}

/** 处理棋子当前所在格子的事件 */
async function dispatchCell() {
  const cell = board[state.pos];
  const tier = tierOf(layerOf(state.pos));

  if (cell.type === "goal") {
    await doWin();
  } else if (cell.type === "punish") {
    await handlePunish(cell, tier);
  } else if (cell.type === "challenge") {
    await handleChallenge(cell, tier);
  } else if (cell.type === "interrogate") {
    await handleInterrogate(cell, tier);
  } else if (cell.type === "minigame") {
    await handleMinigame(cell, tier);
  } else if (cell.type === "massager") {
    await handleMassager(cell);
  } else if (cell.type === "sock") {
    await handleSock(cell);
  } else if (cell.type === "reward") {
    await handleReward(cell);
  } else if (cell.type === "reverse") {
    await handleReverse(cell, tier);
  } else if (cell.type === "portal") {
    await handlePortal();
  }
}

/** 终点走过头后，可以选择换一个本层姿势（久攻不下时换个花样） */
async function offerPostureRedraw() {
  if (!settings.postures.length) return;
  const yes = await showModal(
    cardHTML({
      icon: "🧘", title: "又没进终点……",
      desc: `当前姿势是【<b>${esc(state.posture)}</b>】。<br>要不要趁这次机会<b>重新抽一个姿势</b>？`,
      sub: "换了就按新姿势继续；不换就保持原样。",
    }),
    [
      { text: "🎡 换一个姿势", cls: "btn-warn", value: true },
      { text: "不换，继续", cls: "btn-success", value: false },
    ]
  );
  if (!yes) { addLog("🧘 选择保持原姿势继续。"); return; }
  await drawPosture(layerOf(state.pos), { force: true });
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
  if (layerOf(state.pos) === state.layers - 1 && n > remaining) {
    // 只有终点必须正好踩中（其余层碰到入口会自动进入，不存在走过头）
    AudioFX.fail();
    $("#roll-hint").textContent = `😵 走过头了！距终点只剩 ${remaining} 格，原地不动。`;
    addLog(`😵 掷出 ${n} 点但只差 ${remaining} 格，走过头无效！`, true);
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 500);
    await offerPostureRedraw();
  } else {
    const entered = await moveSteps(n);
    if (!entered) await dispatchCell();

    if (!state.over && GOAL - state.pos > 0) updateRollHint();
  }

  state.busy = false;
  rollBtn.disabled = state.over;
}

/** 刷新骰子下方的状态提示（剩余格数 / 持有的卡） */
function updateRollHint() {
  const left = GOAL - state.pos;
  if (left <= 0) return;
  $("#roll-hint").textContent =
    `距离终点还有 ${left} 格` +
    (state.shield ? "（🛡️护体中）" : "") +
    (state.massagerOn ? "（📳按摩仪工作中）" : "") +
    (state.rerollCards > 0 ? `（🎲重抽卡×${state.rerollCards}）` : "");
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
async function startGame() {
  const victim = $("#input-victim").value.trim();
  const master = $("#input-master").value.trim();
  if (victim) settings.victim = victim;
  if (master) settings.master = master;
  const ultimate = $("#input-ultimate").value.trim();
  settings.ultimate = ultimate || DEFAULT_ULTIMATE;
  settings.uniquePosture = $("#input-unique-posture").checked;
  settings.layers = Number($("#input-layers").value) || MIN_LAYERS;
  settings.layers = Math.min(maxLayersAllowed(), Math.max(MIN_LAYERS, settings.layers));
  settings.massager = $("#input-massager").checked;
  settings.spank = $("#input-spank").checked;
  settings.chalReward = $("#input-chal-reward").value.trim();
  settings.chalFail = $("#input-chal-fail").value.trim();
  settings.winReward = $("#input-win-reward").value.trim();
  if (!settings.tools.length) {
    settings.tools = DEFAULT_TOOLS.map((t) => ({ ...t }));
    renderToolList();
  }
  if (!settings.postures.length) {
    settings.postures = DEFAULT_POSTURES.slice();
    renderPostureList();
  }
  saveSettings();

  state.posturePool = settings.postures.slice();
  state.postureDrawn = [];

  state.layers = settings.layers;
  state.pos = 0;
  state.busy = true;
  state.over = false;
  state.shield = false;
  state.rerollCards = 0;
  state.massagerOn = false;
  state.posture = "";

  buildBoard();
  renderTabs();

  $("#screen-setup").classList.remove("active");
  $("#screen-game").classList.add("active");
  renderBoard(0);
  setDiceFace(1);
  addLog(`🚩 冒险开始！${settings.victim} 踏上了 ${state.layers} 层挠痒地狱之旅……祝好运（不）。`, true);
  $("#roll-hint").textContent = `距离终点还有 ${GOAL} 格`;
  AudioFX.ensure();
  AudioFX.magic();

  // 开局先抽第一层姿势
  await sleep(600);
  await drawPosture(0);
  state.busy = false;
  $("#btn-roll").disabled = false;
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
  $("#input-ultimate").value = settings.ultimate;
  $("#input-layers").value = settings.layers;
  $("#layers-value").textContent = `${settings.layers} 层`;
  $("#input-massager").checked = settings.massager;
  $("#input-spank").checked = !!settings.spank;
  $("#input-unique-posture").checked = !!settings.uniquePosture;
  $("#input-chal-reward").value = settings.chalReward || "";
  $("#input-chal-fail").value = settings.chalFail || "";
  $("#input-win-reward").value = settings.winReward || "";
  renderToolList();
  renderPostureList();
  refreshLimits();

  $("#input-layers").addEventListener("input", () => {
    settings.layers = Number($("#input-layers").value) || MIN_LAYERS;
    $("#layers-value").textContent = `${settings.layers} 层`;
    refreshLimits();
    saveSettings();
    AudioFX.tick();
  });

  $("#input-unique-posture").addEventListener("change", async () => {
    const box = $("#input-unique-posture");
    if (box.checked && settings.postures.length < MIN_LAYERS) {
      // 姿势太少，连最低的 3 层都排不满
      box.checked = false;
      AudioFX.fail();
      await showModal(
        cardHTML({
          icon: "🚫", title: "姿势不够",
          desc: `「每层姿势不重复」至少需要 ${MIN_LAYERS} 个姿势（最低 ${MIN_LAYERS} 层），当前只有 ${settings.postures.length} 个。`,
          sub: "先添加几个姿势，再来勾选吧。",
        }),
        [{ text: "知道了", value: 1 }]
      );
      return;
    }
    settings.uniquePosture = box.checked;
    refreshLimits();   // 勾选后层数会自动收进姿势数量以内
    saveSettings();
    AudioFX.tick();
  });

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

  $("#btn-add-posture").onclick = () => {
    const name = $("#input-posture-name").value.trim();
    if (!name) return;
    if (settings.postures.includes(name)) return;
    settings.postures.push(name);
    $("#input-posture-name").value = "";
    renderPostureList();
    refreshLimits();   // 姿势变多后层数上限也跟着放开
    saveSettings();
    AudioFX.tick();
  };
  $("#input-posture-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-add-posture").click();
  });

  $("#btn-dex").onclick = () => { AudioFX.tick(); showDex(); };
  $("#btn-dex-game").onclick = () => {
    if (state.busy || overlay.classList.contains("active")) return;
    AudioFX.tick();
    showDex();
  };

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
        sub: "终极惩罚的内容是保密的，认输之后才会揭晓……",
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
