/* =========================================================
   state.js —— 游戏状态定义 / 初始化 / 派生计算 / 存读档
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util, C = SG.CONST;

  /* ---------------- 日志 ---------------- */
  var LOG_MAX = 220;

  /* =========================================================
     创建一局新游戏
     cfg = { scenarioId, playerFactionId, aiCount, pace }
     ========================================================= */
  function create(cfg) {
    var sc = SG.data.scenarioById(cfg.scenarioId);
    var pace = SG.data.PACES[cfg.pace] || SG.data.PACES.normal;

    var state = {
      scenarioId: sc.id,
      scenarioName: sc.name,
      pace: pace.key,
      maxRound: Math.max(12, Math.round(sc.maxRound * pace.mul)),
      aiSkill: sc.aiSkill || 1,
      turn: 0,
      round: 1,
      phase: SG.PHASE.IDLE,
      currentFactionId: null,
      playerFactionId: cfg.playerFactionId,
      tiles: [],
      generals: [],
      factions: [],
      log: [],
      tollFree: {}          // factionId -> 剩余免过路回合数
    };

    /* --- 棋盘格子 --- */
    SG.data.TILES.forEach(function (t) {
      state.tiles.push({
        i: t.i,
        name: t.name,
        type: t.type,
        region: t.region,
        price: t.price,
        income: t.income,
        level: 0,                       // 0 = 未占领
        ownerId: null,
        buildings: [],                  // ['market','farm','drill','moat']
        garrison: { generalId: null, troops: 0 }
      });
    });

    /* --- 武将池（全部克隆；开局皆在野，仅被点名的大将归入势力）--- */
    state.generals = SG.data.GENERALS.map(function (g) {
      var o = {};
      Object.keys(g).forEach(function (k) { o[k] = g[k]; });
      o.faction = null;      // 状态中的归属；数据表里的 faction 仅表示“心仪倾向”
      o.cityId = null;
      return o;
    });

    /* --- 势力：玩家 + 若干电脑 --- */
    var ids = [cfg.playerFactionId].concat(
      SG.data.FACTION_ORDER.filter(function (id) { return id !== cfg.playerFactionId; })
        .slice(0, Math.max(1, cfg.aiCount || 2))
    );

    ids.forEach(function (fid) {
      var base = SG.data.factionById(fid);
      var isAI = fid !== cfg.playerFactionId;
      var mul = isAI ? sc.aiMul : sc.mul;
      var f = {
        id: base.id,
        name: base.name,
        lord: base.lord,
        color: base.color,
        desc: base.desc,
        perk: base.perk,
        isAI: isAI,
        gold: Math.round(base.gold * mul.gold),
        food: Math.round(base.food * mul.food),
        troops: Math.round(base.troops * mul.troops),
        cityIds: [],
        generalIds: [],
        capitalId: base.capital,
        pos: base.capital,            // 棋子当前所在格
        alive: true,
        fame: 0
      };

      /* 初始城池（本城）*/
      var cap = state.tiles[base.capital];
      if (cap && !cap.ownerId) {
        cap.ownerId = f.id;
        cap.level = 1;
        f.cityIds.push(cap.i);
      }

      /* 初始武将驻守本城 */
      base.generals.forEach(function (gname, idx) {
        var g = state.generals.filter(function (x) { return x.name === gname && !x.faction; })[0];
        if (!g) return;
        g.faction = f.id;
        g.cityId = f.capitalId;
        f.generalIds.push(g.id);
        if (idx === 0 && cap) {
          cap.garrison.generalId = g.id;
          cap.garrison.troops = 200;
        }
      });

      state.factions.push(f);
    });

    SG.State.log(state, '【' + sc.name + '】乱世开启，' +
      state.factions.map(function (f) { return f.name; }).join('、') + ' 逐鹿天下。', 'turn');
    SG.State.log(state, '你的势力：' + SG.State.faction(state, cfg.playerFactionId).name +
      '　目标：统一天下，或于 ' + state.maxRound + ' 回合内富甲天下。', 'gold');

    return state;
  }

  /* =========================================================
     派生计算与查询
     ========================================================= */
  var S = SG.State = {
    create: create,

    /* ---- 基础查询 ---- */
    faction: function (state, id) {
      for (var i = 0; i < state.factions.length; i++) if (state.factions[i].id === id) return state.factions[i];
      return null;
    },
    tile: function (state, i) { return state.tiles[SG.util.mod(i, C.BOARD_N)]; },
    general: function (state, id) {
      for (var i = 0; i < state.generals.length; i++) if (state.generals[i].id === id) return state.generals[i];
      return null;
    },
    generalsOf: function (state, fid) {
      return state.generals.filter(function (g) { return g.faction === fid; });
    },
    citiesOf: function (state, fid) {
      var self = this;
      return state.tiles.filter(function (t) { return t.ownerId === fid; });
    },
    /* 在野武将（可招募）*/
    freeGenerals: function (state) {
      return state.generals.filter(function (g) { return !g.faction; });
    },
    aliveFactions: function (state) {
      return state.factions.filter(function (f) { return f.alive; });
    },
    adjacent: function (state, i) {
      return [SG.util.mod(i - 1, C.BOARD_N), SG.util.mod(i + 1, C.BOARD_N)];
    },
    /* 某势力在某地域占有的城池数 */
    regionCount: function (state, fid, region) {
      return state.tiles.filter(function (t) {
        return t.ownerId === fid && t.region === region;
      }).length;
    },
    buildingsOf: function (tile, key) {
      var n = 0;
      for (var i = 0; i < tile.buildings.length; i++) if (tile.buildings[i] === key) n++;
      return n;
    },

    /* ---- 单城收益 ---- */
    cityIncome: function (state, tile) {
      var res = { gold: 0, food: 0, troops: 0 };
      if (!tile.ownerId || tile.level <= 0) return res;
      var f = this.faction(state, tile.ownerId);
      if (!f) return res;

      var gold = tile.income * tile.level;

      /* 市集 +30%/座 */
      gold *= (1 + 0.30 * this.buildingsOf(tile, 'market'));

      /* 联片加成：同地域 ≥3 城 */
      if (tile.region && this.regionCount(state, f.id, tile.region) >= 3) {
        gold *= (1 + SG.data.REGIONS[tile.region].bonus);
      }
      /* 孙权的江东加成 */
      if (f.perk.key === 'jiangDong' && tile.region === 'jiangdong') gold *= 1.2;

      res.gold = Math.round(gold);

      /* 农田建筑：+60 粮/座（曹操屯田 +30%）*/
      var food = 60 * this.buildingsOf(tile, 'farm');
      if (f.perk.key === 'tunTian') food *= 1.3;
      res.food = Math.round(food);

      /* 练兵场：+30 兵/座 */
      res.troops = 30 * this.buildingsOf(tile, 'drill');

      return res;
    },

    /* ---- 势力整回合收益合计 ---- */
    totalIncome: function (state, fid) {
      var self = this, sum = { gold: 0, food: 0, troops: 0 };
      state.tiles.forEach(function (t) {
        if (t.ownerId !== fid) return;
        var r = self.cityIncome(state, t);
        sum.gold += r.gold; sum.food += r.food; sum.troops += r.troops;
      });
      return sum;
    },

    /* ---- 过路费 ---- */
    tollOf: function (state, tile) {
      var base = tile.income * Math.max(1, tile.level) * C.TOLL_RATE;
      if (tile.type === 'pass') base = tile.income * C.TOLL_RATE;
      var f = this.faction(state, tile.ownerId);
      if (f && f.perk.key === 'baoNue') base *= 0.85;   // 董卓过路费收入 -15%
      return Math.round(base);
    },

    /* ---- 升级 / 建设成本 ---- */
    upgradeCost: function (tile) {
      var lv = Math.max(1, tile.level);
      return Math.round(tile.price * (0.6 + 0.45 * lv) * Math.pow(lv, 1.15) / 10) * 10;
    },
    buildCost: function (tile, key) {
      var n = tile.buildings.length;
      var base = { market: 320, farm: 260, drill: 300, moat: 280 }[key] || 300;
      return Math.round(base * (1 + 0.55 * n) / 10) * 10;
    },

    /* ---- 总资产（结算用）---- */
    totalAssets: function (state, fid) {
      var f = this.faction(state, fid);
      if (!f) return 0;
      var cityVal = SG.util.sum(this.citiesOf(state, fid), function (t) {
        return t.price * (1 + 0.35 * (Math.max(1, t.level) - 1)) * C.CITY_VALUE_RATE;
      });
      return Math.round(f.gold + cityVal + f.troops * C.SOLDIER_VALUE + f.food * 0.5);
    },

    /* ---- 城池战力（守城防御）---- */
    defenseOf: function (state, tile) {
      var t = tile;
      var g = t.garrison.generalId ? this.general(state, t.garrison.generalId) : null;
      var lead = g ? g.lead : 30;
      var war = g ? g.war : 20;
      var base = (t.garrison.troops + state.tiles.length * 0) + t.garrison.troops * (lead / 200);
      var bonus = 1 + 0.15 * Math.max(0, t.level - 1) + 0.25 * this.buildingsOf(t, 'drill') + 0.35 * this.buildingsOf(t, 'moat');
      return Math.round((t.garrison.troops + 100) * (1 + lead / 200 + war / 400) * bonus);
    },

    /* ---- 招募价格与相性（含势力特性）---- */
    recruitPrice: function (state, f, g) {
      var p = SG.data.generalPrice(g);
      if (f.perk.key === 'renDe') p = Math.round(p * 0.8 / 10) * 10;
      return p;
    },
    affinityTo: function (state, f, g) {
      var a = SG.data.affinity(g, f.id);
      if (f.perk.key === 'renDe') a += 10;
      return SG.util.clamp(a, 5, 99);
    },

    /* ---- 日志 ---- */
    log: function (state, text, cls) {
      state.log.push({ t: text, cls: cls || '' });
      if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
      SG.bus.emit('log', state.log[state.log.length - 1]);
    },

    /* =========================================================
       存读档（localStorage，失败时降级内存）
       ========================================================= */
    _mem: null,

    toJSON: function (state) { return JSON.stringify(state); },

    save: function (state) {
      var text = this.toJSON(state);
      try {
        localStorage.setItem(C.SAVE_KEY, text);
        this._mem = text;
        return { ok: true, bytes: text.length };
      } catch (e) {
        this._mem = text;                 // file:// 下部分浏览器会拒绝写入
        return { ok: false, bytes: text.length, error: e };
      }
    },

    load: function () {
      var text = null;
      try { text = localStorage.getItem(C.SAVE_KEY); } catch (e) { /* ignore */ }
      if (!text) text = this._mem;
      if (!text) return null;
      try {
        var state = JSON.parse(text);
        if (!state || !state.tiles || !state.factions) return null;
        return state;
      } catch (e) { return null; }
    },

    hasSave: function () {
      var t = null;
      try { t = localStorage.getItem(C.SAVE_KEY); } catch (e) { /* ignore */ }
      return !!(t || this._mem);
    },

    clearSave: function () {
      try { localStorage.removeItem(C.SAVE_KEY); } catch (e) { /* ignore */ }
      this._mem = null;
    }
  };

  /* 兼容引用：SG.State 亦作为 SG.state 命名空间 */
  SG.state = SG.State;

})();
