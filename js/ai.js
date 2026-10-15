/* =========================================================
   ai.js —— 电脑势力决策
   设计原则：简单、可解释、易调参。参数集中在 SG.AI.PARAMS，
   所有决策都带 ±15% 随机抖动，避免机械感。
   调用方式：SG.AI.answer(state, faction, spec) → Promise
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util;

  var PARAMS = SG.AI_PARAMS = {
    reserveGold: 520,      // 手头至少保留的现金
    paybackFactor: 1.25,   // 回本周期容忍倍数（越小越激进买地）
    upgradeFactor: 1.15,   // 升级回本容忍倍数
    warRatio: 1.32,        // 出兵/宣战所需战力比
    tollTolerance: 0.17,   // 过路费 / 现金 超过此比例则宁可开战
    salaryReserve: 4,      // 招募后需保留 salary * N 的现金
    jitter: 0.15
  };

  /* 按电脑强度微调参数：skill 越高越激进、越不留冗余 */
  function paramsOf(state) {
    var s = state.aiSkill || 1;
    return {
      reserveGold: PARAMS.reserveGold / s,
      paybackFactor: PARAMS.paybackFactor / s,
      upgradeFactor: PARAMS.upgradeFactor / s,
      warRatio: PARAMS.warRatio / (0.6 + 0.4 * s),
      tollTolerance: PARAMS.tollTolerance * (2 - s),
      salaryReserve: PARAMS.salaryReserve,
      jitter: PARAMS.jitter
    };
  }

  function jit(p, v) {
    var d = 1 + util.rand(-p.jitter, p.jitter);
    return v * d;
  }

  /* 势力最强武将（按武力+统率） */
  function bestGeneral(state, faction) {
    var list = SG.State.generalsOf(state, faction.id);
    if (!list.length) return null;
    return list.slice().sort(function (a, b) {
      return (b.war + b.lead) - (a.war + a.lead);
    })[0];
  }

  /* 估算一支军队的战力（不含随机） */
  function powerOf(troops, g, defBonus) {
    var lead = g ? g.lead : 40, war = g ? g.war : 30;
    return troops * (1 + lead / 200 + war / 500) * (defBonus || 1);
  }

  /* ---------------- 各类决策 ---------------- */

  /* 买地 */
  function decideBuy(state, f, p, tile) {
    var cost = tile.price;
    if (f.gold - cost < p.reserveGold) return false;
    var payback = cost / Math.max(1, tile.income);            // 几回合回本
    var remaining = state.maxRound - state.round;
    var ok = remaining * jit(p, 1) > payback * p.paybackFactor;
    if (!ok) return false;
    /* 同地域已有城池时会略微更想买 */
    if (tile.region && SG.State.regionCount(state, f.id, tile.region) >= 2) ok = true;
    return ok;
  }

  /* 路过敌城：交税 or 宣战 */
  function decideWar(state, f, p, spec) {
    var tile = spec.tile;
    var toll = spec.toll;
    if (f.gold < toll) return 'war';                  // 付不起，只能打
    var g = bestGeneral(state, f.id);
    var aPower = powerOf(Math.min(f.troops, 320), g, 1);
    var dPower = SG.State.defenseOf(state, tile);
    if (aPower > dPower * jit(p, p.warRatio)) return 'war';
    if (toll > f.gold * p.tollTolerance) return 'war';  // 过路费太肉疼
    return 'pay';
  }

  /* 升级己城 */
  function decideUpgrade(state, f, p, tile) {
    if (tile.level >= SG.CONST.MAX_LEVEL) return false;
    var cost = SG.State.upgradeCost(tile);
    if (f.gold - cost < p.reserveGold) return false;
    var gain = tile.income;                            // 升一级带来的收益增量
    var remaining = state.maxRound - state.round;
    return remaining * jit(p, 1) > (cost / Math.max(1, gain)) * p.upgradeFactor;
  }

  /* 建设：返回建筑 key 或 null */
  function decideBuild(state, f, p, spec) {
    var tile = spec.tile;
    var choices = spec.choices || [];
    if (!choices.length) return null;

    var needFood = f.food < (f.troops / SG.CONST.TROOP_FOOD_COST) * 6;
    var threat = SG.State.adjacent(state, tile.i).some(function (idx) {
      var t = SG.State.tile(state, idx);
      return (t.type === 'city' || t.type === 'pass') && t.ownerId && t.ownerId !== f.id;
    });

    /* 打分 */
    var score = {};
    choices.forEach(function (k) {
      var c = SG.State.buildCost(tile, k);
      if (f.gold - c < p.reserveGold * 0.5) { score[k] = -1; return; }
      var s = 1 + util.rand(0, 0.4);
      if (k === 'market') s += 0.8;                    // 市集最百搭
      if (k === 'farm') s += needFood ? 1.3 : -0.2;
      if (k === 'drill') s += (threat ? 0.9 : -0.3) + (f.troops < 400 ? 0.5 : 0);
      if (k === 'moat') s += threat ? 1.0 : -0.5;
      score[k] = s;
    });

    var best = null, bestS = 0;
    Object.keys(score).forEach(function (k) {
      if (score[k] > bestS) { bestS = score[k]; best = k; }
    });
    return bestS > 0.9 ? best : null;
  }

  /* 招募：返回 generalId 或 null */
  function decideRecruit(state, f, p, spec) {
    var cands = (spec.candidates || []).filter(function (c) { return c.general; });
    if (!cands.length) return null;

    var best = null, bestV = 0;
    cands.forEach(function (c) {
      var g = c.general;
      var price = c.price;
      if (f.gold - price < g.salary * p.salaryReserve + p.reserveGold * 0.3) return;
      var aff = SG.data.affinity(g, f.id);
      var v = (g.war * 2 + g.intel + g.lead * 1.2 + aff * 1.5) / Math.max(1, price / 100);
      v *= jit(p, 1);
      if (v > bestV) { bestV = v; best = g.id; }
    });
    return best;
  }

  /* 出兵夺城：返回 { tileIndex, troops, generalId } 或 null */
  function decideSiege(state, f, p, spec) {
    var targets = spec.targets || [];
    if (!targets.length) return null;
    if (f.troops < 200) return null;

    var g = bestGeneral(state, f.id);
    var best = null, bestScore = 0;

    targets.forEach(function (t) {
      var dPower = SG.State.defenseOf(state, t);
      var send = Math.min(f.troops - 80, 900);
      if (send < 180) return;
      var aPower = powerOf(send, g, 1);
      var ratio = aPower / Math.max(1, dPower);
      if (ratio < jit(p, p.warRatio)) return;
      var score = (t.income / Math.max(1, t.price)) * 100 + ratio * 2 + (t.level - 1);
      if (score > bestScore) {
        bestScore = score;
        best = { tileIndex: t.i, troops: send, generalId: g ? g.id : null };
      }
    });
    return best;
  }

  /* ---------------- 统一入口 ---------------- */
  function answer(state, faction, spec) {
    var p = paramsOf(state);
    return util.delay(SG.CONST.AI_THINK_MS).then(function () {
      switch (spec.kind) {
        case 'buy':     return decideBuy(state, faction, p, spec.tile);
        case 'war':     return decideWar(state, faction, p, spec);
        case 'upgrade': return decideUpgrade(state, faction, p, spec.tile);
        case 'build':   return decideBuild(state, faction, p, spec);
        case 'recruit': return decideRecruit(state, faction, p, spec);
        case 'siege':   return decideSiege(state, faction, p, spec);
        case 'endTurn': return true;
        /* 落空地若选择不买、招募若选 null，均走此兜底 */
        default:        return spec.dflt !== undefined ? spec.dflt : null;
      }
    });
  }

  SG.AI = {
    PARAMS: PARAMS,
    answer: answer,
    bestGeneral: bestGeneral,
    powerOf: powerOf,
    paramsOf: paramsOf
  };

})();
