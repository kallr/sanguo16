/* =========================================================
   engine.js —— 回合状态机与全部结算逻辑
   人机统一：人类决策走弹窗 Promise，AI 决策走 SG.AI.answer，
   两者在引擎看来都是 await 一个值，规则不写在渲染层。
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util, el = SG.el, C = SG.CONST, P = SG.PHASE, T = SG.TYPE;
  var UI = null;   // 延迟取，避免脚本顺序问题

  var state = null;
  var onEnd = null;
  var stopped = false;
  var gen = 0;        // 每开一局递增，用于作废旧对局残留的异步循环
  var runGen = 0;

  /* 当前循环是否已过期（旧对局被新对局取代） */
  function stale() { return runGen !== gen; }

  function ui() { return SG.UI; }

  /* =========================================================
     初始化与主循环
     ========================================================= */
  function init(st, opts) {
    gen++;
    state = st;
    UI = SG.UI;
    onEnd = (opts && opts.onEnd) || function () { };
    stopped = false;
    state.over = false;
  }

  function start() {
    SG.Board.init(state, SG.$('#board'));
    UI.resetLog(state);
    UI.renderAll(state);
    runLoop(false);
  }

  /* 读档续玩：保留回合数与局面，直接从玩家的回合继续 */
  function continueGame() {
    SG.Board.init(state, SG.$('#board'));
    state.factions.forEach(function (f) { SG.Board.setPiecePos(f.id, f.pos, true); });
    UI.resetLog(state);
    UI.renderAll(state);
    stopped = false;
    state.over = false;
    state.phase = P.IDLE;

    /* 直接交回玩家手中，免得读档后先干等一轮电脑行动 */
    var pf = SG.State.faction(state, state.playerFactionId);
    if (pf && pf.alive) {
      state.currentFactionId = state.playerFactionId;
    } else {
      var alive = SG.State.aliveFactions(state);
      state.currentFactionId = alive.length ? alive[0].id : null;
    }
    if (!state.currentFactionId) return;

    runLoop(true);
  }

  async function runLoop(resume) {
    if (!resume) {
      var alive0 = SG.State.aliveFactions(state);
      if (!alive0.length) return;
      state.currentFactionId = alive0[0].id;
      state.turn = 0;
      state.round = 1;
    }
    if (!state.currentFactionId) state.currentFactionId = SG.State.aliveFactions(state)[0].id;

    runGen = gen;
    while (!stopped && !state.over && runGen === gen) {
      var f = SG.State.faction(state, state.currentFactionId);
      state.turn++;

      if (!f || !f.alive) {
        if (!advance()) return;
        continue;
      }

      try {
        await turnOf(f);
      } catch (err) {
        /* 单个回合出错不应让整局卡死；同时记下出错位置便于排查 */
        var where = '';
        if (err && err.stack) {
          var line = String(err.stack).split('\n')[1];
          if (line) where = '　@' + line.trim();
        }
        console.error('[engine] 回合结算异常：', err);
        SG.State.log(state, '（' + f.name + ' 的本回合结算出现异常，已跳过：' +
          (err && err.message) + where + '）', 'bad');
      }
      if (stopped || state.over || stale()) return;

      var res = checkOutcome();
      if (res) { finish(res); return; }

      if (!advance()) return;
      if (state.round > state.maxRound) { finish({ type: 'wealth' }); return; }

      SG.Board.teleportPiece(state.currentFactionId, SG.State.faction(state, state.currentFactionId).pos);
    }
  }

  /* 切换到下一个存活势力；返回 false 表示已无人可轮 */
  function advance() {
    var order = state.factions.map(function (x) { return x.id; });
    var from = order.indexOf(state.currentFactionId);
    for (var k = 1; k <= order.length; k++) {
      var nid = order[(k + from) % order.length];
      var nf = SG.State.faction(state, nid);
      if (nf && nf.alive) {
        if (order.indexOf(nid) <= from) state.round++;   // 绕回一圈
        state.currentFactionId = nid;
        return true;
      }
    }
    return false;
  }

  /* =========================================================
     单个势力的一个回合
     ========================================================= */
  async function turnOf(f) {
    state.phase = P.TURN_START;
    SG.Board.focusPiece(f.id);
    UI.renderAll(state);
    UI.setTurnBanner(turnBannerHTML(f));
    UI.setCenterInfo(centerHTML(f));
    UI.setBoardActions([]);
    await util.delay(160);

    settleTurnStart(f);
    UI.renderAll(state);

    /* --- 掷骰 --- */
    state.phase = P.ROLL;
    var dice = await doRoll(f);
    if (stale()) return;

    /* --- 移动 --- */
    state.phase = P.MOVE;
    var mv = await doMove(f, dice);
    if (stale()) return;
    UI.renderAll(state);

    /* --- 落地结算 --- */
    state.phase = P.LAND;
    await doLand(f, mv.end, mv.path);
    if (stale()) return;
    UI.renderAll(state);

    /* --- 行动阶段 --- */
    state.phase = P.ACTION;
    await doAction(f);
    if (stale()) return;
    UI.renderAll(state);

    state.phase = P.END;
    SG.State.save(state);            // 每回合自动存档
    await util.delay(200);
  }

  function turnBannerHTML(f) {
    var who = f.id === state.playerFactionId
      ? '你的回合'
      : '电脑·' + f.name + ' 的回合';
    return '<b style="color:' + f.color + '">' + f.name + '</b>　' + who +
      '　<span style="color:#a2967e;font-size:12px">第 ' + state.round + ' / ' + state.maxRound + ' 回合</span>';
  }

  function centerHTML(f) {
    return '<b style="color:' + f.color + '">' + f.name + '</b>　' +
      '金 <b>' + util.num(f.gold) + '</b>　粮 <b>' + util.num(f.food) + '</b>　兵 <b>' + util.num(f.troops) + '</b><br>' +
      '<span style="font-size:12px">都城 ' + SG.State.tile(state, f.capitalId).name +
      '　城池 ' + SG.State.citiesOf(state, f.id).length + ' 座　武将 ' + SG.State.generalsOf(state, f.id).length + ' 员</span>';
  }

  /* ---------------- 回合开始：收益 / 粮耗 / 免过路 ---------------- */
  function settleTurnStart(f) {
    var inc = SG.State.totalIncome(state, f.id);
    f.gold += inc.gold;
    f.food += inc.food;
    f.troops += inc.troops;

    /* 粮耗：每 10 兵 1 粮 */
    var eat = Math.floor(f.troops / C.TROOP_FOOD_COST);
    f.food -= eat;
    if (f.food < 0) {
      f.food = 0;
      var lost = Math.round(f.troops * 0.12);
      f.troops = Math.max(0, f.troops - lost);
      SG.State.log(state, f.name + ' 粮草不继，' + util.num(lost) + ' 名士卒逃散。', 'bad');
    }

    if (inc.gold || inc.food || inc.troops) {
      SG.State.log(state, f.name + ' 治下收益：+' + util.num(inc.gold) + ' 金' +
        (inc.food ? '、+' + util.num(inc.food) + ' 粮' : '') +
        (inc.troops ? '、+' + util.num(inc.troops) + ' 兵' : '') +
        '　（军粮耗 ' + util.num(eat) + '）', 'gold');
    }

    if (state.tollFree[f.id] > 0) {
      state.tollFree[f.id]--;
      if (state.tollFree[f.id] === 0) SG.State.log(state, f.name + ' 的免过路金牌已失效。', '');
    }

    resolveDebt(f);
  }

  /* 现金为负时变卖城池抵债；无地可卖则出局 */
  function resolveDebt(f) {
    var guard = 0;
    while (f.gold < 0 && guard++ < 20) {
      var cities = SG.State.citiesOf(state, f.id).filter(function (t) { return t.i !== f.capitalId; });
      if (!cities.length) cities = SG.State.citiesOf(state, f.id);
      if (!cities.length) break;
      cities.sort(function (a, b) { return a.price - b.price; });
      var t = cities[0];
      var gain = Math.round(t.price * 0.7);
      t.ownerId = null;
      t.level = 0;
      t.buildings = [];
      if (t.garrison.generalId) {
        var g = SG.State.general(state, t.garrison.generalId);
        if (g) g.cityId = null;
      }
      t.garrison.generalId = null;
      t.garrison.troops = 0;
      f.gold += gain;
      SG.State.log(state, f.name + ' 困于财绌，只得变卖 ' + t.name + ' 得 ' + util.num(gain) + ' 金。', 'bad');
    }
    if (f.gold < 0) {
      f.gold = 0;
      f.alive = false;
      SG.State.log(state, f.name + ' 财尽粮绝，势力覆灭。', 'bad');
      SG.Board.syncPieces();
    }
  }

  /* =========================================================
     掷骰
     ========================================================= */
  function doRoll(f) {
    return new Promise(function (resolve) {
      function roll() {
        SG.Board.rolling(true, '骰子翻飞…');
        return util.delay(C.DICE_MS).then(function () {
          var v = util.randInt(1, 6);
          SG.Board.rolling(false);
          SG.Board.setDice(v, '点数 ' + v);
          SG.State.log(state, f.name + ' 掷出 ' + v + ' 点。', '');
          return v;
        });
      }

      if (f.isAI) {
        return util.delay(520).then(roll).then(resolve);
      }
      SG.Board.setDice(null, '轮到你掷骰');
      UI.setBoardActions([
        el('button', {
          class: 'btn btn-primary btn-lg', text: '🎲 掷 骰 子',
          onclick: function () {
            UI.setBoardActions([]);
            roll().then(resolve);
          }
        })
      ]);
    });
  }

  /* =========================================================
     移动
     ========================================================= */
  function doMove(f, dice) {
    UI.setCenterInfo('<b style="color:' + f.color + '">' + f.name + '</b> 行进中…');
    return SG.Board.movePiece(f.id, f.pos, dice).then(function (mv) {
      f.pos = mv.end;
      if (mv.path.indexOf(0) >= 0) {
        f.gold += 300;
        SG.State.log(state, f.name + ' 途经起点，领取俸禄 300 金。', 'good');
        UI.toast(f.name + ' 途经起点 +300 金', 'good');
      }
      var tile = SG.State.tile(state, mv.end);
      SG.State.log(state, f.name + ' 抵达 ' + tile.name + '。', '');
      return mv;
    });
  }

  /* =========================================================
     落地结算
     ========================================================= */
  async function doLand(f, idx, path) {
    var tile = SG.State.tile(state, idx);

    switch (tile.type) {
      case T.START:
        SG.State.log(state, f.name + ' 回到起点休整。', '');
        break;

      case T.FARM:
        var gain = 200;
        f.food += gain;
        SG.State.log(state, f.name + ' 在农田督收，获得 ' + util.num(gain) + ' 粮。', 'good');
        UI.toast(f.name + ' 获粮 ' + util.num(gain), 'good');
        break;

      case T.EVENT:  await drawCard(f, 'event');  break;
      case T.CHANCE: await drawCard(f, 'chance'); break;
      case T.TAVERN: await tavernVisit(f);        break;

      case T.CITY:
      case T.PASS:
        await cityLanding(f, tile);
        break;
    }
  }

  /* ---------------- 城池 / 关隘 落地 ---------------- */
  async function cityLanding(f, tile) {
    /* 1) 无主 */
    if (!tile.ownerId) {
      var buy = await decideBuy(f, tile);
      if (buy) {
        if (f.gold < tile.price) {
          UI.toast('金钱不足', 'bad');
        } else {
          f.gold -= tile.price;
          occupy(f, tile);
          SG.State.log(state, f.name + ' 以 ' + util.num(tile.price) + ' 金占领了 ' + tile.name +
            '　' + (tile.region ? '（' + SG.data.REGIONS[tile.region].name + '）' : ''), 'good');
          UI.toast(f.name + ' 占领 ' + tile.name, 'good');
          if (isPlayer(f) && tile.type === T.CITY) await cityDevelopDialog(f, tile, true);
        }
      } else {
        SG.State.log(state, f.name + ' 路过无主的 ' + tile.name + '，未加理会。', '');
      }
      return;
    }

    /* 2) 自家 */
    if (tile.ownerId === f.id) {
      if (tile.type === T.CITY) await offerDevelop(f, tile);
      else SG.State.log(state, f.name + ' 巡视自家关隘 ' + tile.name + '。', '');
      return;
    }

    /* 3) 敌方：交税 or 宣战 */
    await enemyCityLanding(f, tile);
  }

  async function enemyCityLanding(f, tile) {
    var owner = SG.State.faction(state, tile.ownerId);
    var toll = SG.State.tollOf(state, tile);

    if (state.tollFree[f.id] > 0) {
      SG.State.log(state, f.name + ' 持免过路金牌，安然通过 ' + tile.name + '。', 'good');
      UI.toast('免过路金牌生效', 'good');
      return;
    }

    var canPay = f.gold >= toll;
    var choice;
    if (f.isAI) {
      choice = await SG.AI.answer(state, f, { kind: 'war', tile: tile, toll: toll });
    } else {
      choice = await UI.ask({
        title: '遭遇 ' + owner.name + ' 的' + (tile.type === T.PASS ? '关隘' : '城池') + '　' + tile.name,
        sub: '过路费 <b style="color:#d9b26a">' + util.num(toll) + '</b> 金　|　你的现金 ' + util.num(f.gold) +
          '　<br>可选择乖乖交税，亦可就地宣战——胜则免单并掠其财，败则赔双倍。',
        options: [
          {
            label: canPay ? '交税 ' + util.num(toll) + ' 金' : '（金币不足，无法交税）',
            value: 'pay', cls: 'btn-ghost', disabled: canPay ? null : 'disabled'
          },
          { label: '⚔ 宣战！', value: 'war', cls: 'btn-primary' }
        ]
      });
    }

    if (choice !== 'war') {
      f.gold -= toll;
      owner.gold += toll;
      SG.State.log(state, f.name + ' 向 ' + owner.name + ' 缴纳过路费 ' + util.num(toll) + ' 金。', 'bad');
      UI.toast('缴纳过路费 ' + util.num(toll), 'bad');
      return;
    }

    await fieldBattle(f, tile, toll, owner);
  }

  /* ---------------- 野战（路过宣战） ---------------- */
  async function fieldBattle(f, tile, toll, owner) {
    var aGen = SG.AI.bestGeneral(state, f);
    var aTroops = Math.min(f.troops, 320);
    var dTroops = Math.max(80, tile.garrison.troops);

    SG.State.log(state, f.name + ' 于 ' + tile.name + ' 向 ' + owner.name + ' 宣战！', 'bad');

    var r = await SG.Battle.run(state, {
      mode: 'field',
      attackerId: f.id, defenderId: owner.id,
      tileIndex: tile.i,
      aTroops: aTroops, dTroops: dTroops,
      aGeneralId: aGen ? aGen.id : null,
      dGeneralId: tile.garrison.generalId
    });

    f.troops = Math.max(0, f.troops - r.aLoss);
    tile.garrison.troops = Math.max(0, tile.garrison.troops - r.dLoss);

    if (r.attackerWins) {
      var take = Math.min(owner.gold, r.goldTaken);
      owner.gold -= take;
      f.gold += take;
      SG.State.log(state, '　→ ' + f.name + ' 得胜，免付过路费，并掠得 ' + util.num(take) + ' 金。', 'good');
      UI.toast('野战得胜！掠得 ' + util.num(take) + ' 金', 'good');
    } else {
      var dbl = toll * 2;
      f.gold -= dbl;
      owner.gold += dbl;
      SG.State.log(state, '　→ ' + f.name + ' 战败，赔付双倍过路费 ' + util.num(dbl) + ' 金。', 'bad');
      UI.toast('野战失利，赔付 ' + util.num(dbl), 'bad');
      resolveDebt(f);
    }
    UI.renderAll(state);
  }

  /* ---------------- 抽卡 ---------------- */
  async function drawCard(f, kind) {
    var card = util.weightedPick(SG.data.cardsOf(kind));
    if (isPlayer(f)) await UI.showCard(card, f.name);
    else UI.toast(f.name + ' 抽到「' + card.name + '」', 'gold');
    applyCardEffect(f, card);
    UI.renderAll(state);
  }

  function applyCardEffect(f, card) {
    var e = card.effect, msgs = [];

    if (e.gold) { f.gold += e.gold; msgs.push((e.gold > 0 ? '+' : '') + util.num(e.gold) + ' 金'); }
    if (e.food) { f.food = Math.max(0, f.food + e.food); msgs.push((e.food > 0 ? '+' : '') + util.num(e.food) + ' 粮'); }
    if (e.troops) { f.troops = Math.max(0, f.troops + e.troops); msgs.push((e.troops > 0 ? '+' : '') + util.num(e.troops) + ' 兵'); }

    if (e.freeToll) {
      state.tollFree[f.id] = (state.tollFree[f.id] || 0) + e.freeToll;
      msgs.push('免过路金牌 ' + e.freeToll + ' 回合');
    }

    if (e.steal) {
      var others = SG.State.aliveFactions(state).filter(function (x) { return x.id !== f.id && x.gold > 0; });
      if (others.length) {
        var t = util.pick(others);
        var amt = Math.min(t.gold, e.steal);
        t.gold -= amt; f.gold += amt;
        msgs.push('自 ' + t.name + ' 掠得 ' + util.num(amt) + ' 金');
      }
    }

    if (e.allPay) {
      SG.State.aliveFactions(state).forEach(function (x) {
        if (x.id !== f.id && x.gold >= e.allPay) { x.gold -= e.allPay; f.gold += e.allPay; }
      });
      msgs.push('四方来贺');
    }

    if (e.freeGeneral) {
      var pool = SG.State.freeGenerals(state);
      var pref = pool.filter(function (g) { return g.pref === f.id; });
      var g = pref.length ? util.pick(pref) : (pool.length ? util.pick(pool) : null);
      if (g) { g.faction = f.id; g.cityId = null; msgs.push('名将 ' + g.name + ' 来投'); }
      else msgs.push('（在野名将已尽）');
    }

    if (e.move) {
      var target = util.mod(f.pos + e.move, C.BOARD_N);
      if (e.move > 0 && f.pos + e.move >= C.BOARD_N) { f.gold += 300; msgs.push('途经起点 +300 金'); }
      f.pos = target;
      SG.Board.teleportPiece(f.id, target);
      msgs.push('前进 ' + e.move + ' 格');
    }

    if (f.gold < 0) resolveDebt(f);

    var bad = (e.gold < 0 || e.food < 0 || e.troops < 0);
    SG.State.log(state, f.name + ' 遇「' + card.name + '」：' + (msgs.join('，') || card.text), bad ? 'bad' : 'good');
  }

  /* =========================================================
     决策包装：普通决策点
     ========================================================= */
  async function decideBuy(f, tile) {
    if (f.isAI) return SG.AI.answer(state, f, { kind: 'buy', tile: tile });

    var inc = tile.income;
    var payback = (tile.price / Math.max(1, inc)).toFixed(1);
    var remain = state.maxRound - state.round;
    return await UI.confirm(
      '占领 ' + tile.name,
      '<div class="kv">' +
      '<div class="kv-item"><div class="kv-k">售价</div><div class="kv-v">' + util.num(tile.price) + '</div></div>' +
      '<div class="kv-item"><div class="kv-k">基础收益</div><div class="kv-v">' + util.num(inc) + '</div></div>' +
      '<div class="kv-item"><div class="kv-k">回本周期</div><div class="kv-v">' + payback + ' 回合</div></div>' +
      '<div class="kv-item"><div class="kv-k">剩余回合</div><div class="kv-v">' + remain + '</div></div>' +
      '</div>' +
      '<p style="color:#a2967e;font-size:12px">' +
      (tile.region ? '地域：' + SG.data.REGIONS[tile.region].name + '　' : '') +
      (tile.type === T.PASS ? '关隘可收取过路费。' : '城池可升级、建设，收益随等级增长。') +
      '</p>',
      '占领（' + util.num(tile.price) + ' 金）',
      '放弃'
    );
  }

  /* 占领并自动委派一名空闲武将 */
  function occupy(f, tile) {
    tile.ownerId = f.id;
    tile.level = 1;
    var idle = SG.State.generalsOf(state, f.id).filter(function (g) { return !g.cityId; });
    if (idle.length) {
      idle.sort(function (a, b) { return (b.war + b.lead) - (a.war + a.lead); });
      var g = idle[0];
      tile.garrison.generalId = g.id;
      g.cityId = tile.i;
      var send = Math.min(200, Math.max(0, f.troops - 120));
      tile.garrison.troops = send;
      f.troops -= send;
    }
  }

  async function offerDevelop(f, tile) {
    if (tile.type !== T.CITY) return;
    if (f.isAI) {
      if (await decideUpgradeAI(f, tile)) { doUpgrade(f, tile); return; }
      var choices = SG.BUILD_LIST.filter(function (k) { return tile.buildings.indexOf(k) < 0; });
      if (choices.length) {
        var k = await SG.AI.answer(state, f, { kind: 'build', tile: tile, choices: choices });
        if (k) doBuild(f, tile, k);
      }
      return;
    }
    await cityDevelopDialog(f, tile, false);
  }

  /* =========================================================
     招贤馆 / 招募
     ========================================================= */
  async function tavernVisit(f) {
    var pool = SG.State.freeGenerals(state);
    if (!pool.length) {
      SG.State.log(state, '招贤馆门可罗雀，已无可招之才。', '');
      UI.toast('在野名将已尽', 'bad');
      return;
    }
    var picks = util.sample(pool, Math.min(4, pool.length));

    if (f.isAI) {
      var gid = await SG.AI.answer(state, f, {
        kind: 'recruit',
        candidates: picks.map(function (g) { return { general: g, price: SG.State.recruitPrice(state, f, g) }; })
      });
      if (gid) await tryRecruit(f, SG.State.general(state, gid));
      return;
    }
    await humanRecruitDialog(f, picks, '招贤馆');
  }

  async function humanRecruitDialog(f, picks, where) {
    while (true) {
      var body = el('div', {});
      picks.forEach(function (g) { body.appendChild(UI.generalCard(g, state, f.id)); });

      var opts = [{ label: '离开', value: null, cls: 'btn-ghost' }];
      picks.forEach(function (g) {
        var price = SG.State.recruitPrice(state, f, g);
        opts.push({
          label: '招募·' + g.name + '（' + util.num(price) + '）',
          value: g.id, cls: 'btn-gold',
          disabled: f.gold < price ? 'disabled' : null
        });
      });

      var pick = await UI.ask({
        title: where,
        sub: '招募须看相性：意气相投者，一言而合；话不投机者，散金亦难。你的现金 ' + util.num(f.gold) + ' 金。',
        body: body, options: opts
      });
      if (!pick) return;

      var g = SG.State.general(state, pick);
      await tryRecruit(f, g);
      UI.renderAll(state);
      picks = picks.filter(function (x) { return !x.faction; });
      if (!picks.length) return;
    }
  }

  async function tryRecruit(f, g) {
    var price = SG.State.recruitPrice(state, f, g);
    if (f.gold < price) { UI.toast('金钱不足', 'bad'); return false; }

    var aff = SG.State.affinityTo(state, f, g);
    var p = util.clamp(0.20 + aff / 120, 0.20, 0.95);

    if (util.chance(p)) {
      f.gold -= price;
      g.faction = f.id;
      g.cityId = null;
      SG.State.log(state, f.name + ' 纳得名将 ' + g.name + '（相性 ' + aff + '）！', 'good');
      UI.toast('招得名将 ' + g.name + '！', 'good');
      return true;
    }
    var fee = Math.round(price * 0.5);
    f.gold -= fee;
    SG.State.log(state, f.name + ' 招揽 ' + g.name + ' 未果，散去车马之资 ' + util.num(fee) + ' 金。', 'bad');
    UI.toast(g.name + ' 婉拒了你的邀请', 'bad');
    return false;
  }

  /* =========================================================
     行动阶段
     ========================================================= */
  async function doAction(f) {
    if (f.isAI) { await aiActions(f); return; }

    while (true) {
      if (stale()) return;
      var act = await humanActionMenu(f);
      if (stale()) return;
      if (act === 'end') break;
      if (act === 'build') await menuBuild(f);
      if (act === 'recruit') await menuRecruit(f);
      if (act === 'siege') await humanSiege(f);
      if (act === 'assign') await menuAssign(f);
    }
    UI.setBoardActions([]);
  }

  function humanActionMenu(f) {
    return new Promise(function (resolve) {
      function btn(label, val, cls) {
        return el('button', {
          class: 'btn ' + (cls || ''), text: label,
          onclick: function () { resolve(val); }
        });
      }
      UI.setCenterInfo('<b style="color:' + f.color + '">' + f.name + '</b>　行动阶段：可继续经营，或结束回合。<br>' +
        '<span style="font-size:12px">金 <b>' + util.num(f.gold) + '</b>　粮 <b>' + util.num(f.food) + '</b>　兵 <b>' + util.num(f.troops) + '</b></span>');
      UI.setBoardActions([
        btn('🏗 建设/升级', 'build'),
        btn('🍶 招募武将', 'recruit'),
        btn('⚔ 出兵攻城', 'siege', 'btn-gold'),
        btn('🛡 委派守将', 'assign'),
        btn('结束回合 ▶', 'end', 'btn-primary')
      ]);
    });
  }

  /* ---- 建设 / 升级 ---- */
  async function menuBuild(f) {
    var cities = SG.State.citiesOf(state, f.id).filter(function (t) { return t.type === T.CITY; });
    if (!cities.length) { UI.toast('你还没有可建设的城池', 'bad'); return; }

    var opts = [{ label: '返回', value: null, cls: 'btn-ghost' }];
    cities.forEach(function (t) {
      opts.push({
        label: t.name + ' Lv' + t.level + '（' + t.buildings.length + '/4）',
        value: t.i, cls: ''
      });
    });
    var idx = await UI.ask({
      title: '建设与升级',
      sub: '选择要经营的城池。升级提升收益，建筑增加产出与防御。现有 ' + util.num(f.gold) + ' 金。',
      options: opts
    });
    if (idx === null) return;
    await cityDevelopDialog(f, SG.State.tile(state, idx), false);
  }

  async function cityDevelopDialog(f, tile, fromLanding) {
    while (true) {
      var lv = tile.level;
      var upCost = SG.State.upgradeCost(tile);
      var inc = SG.State.cityIncome(state, tile);

      var body = el('div', {}, [
        el('div', { class: 'kv' }, [
          el('div', { class: 'kv-item' }, [
            el('div', { class: 'kv-k', text: '等级' }),
            el('div', { class: 'kv-v', text: 'Lv' + lv + ' / ' + C.MAX_LEVEL })
          ]),
          el('div', { class: 'kv-item' }, [
            el('div', { class: 'kv-k', text: '当前收益' }),
            el('div', { class: 'kv-v', text: util.num(inc.gold) + ' 金' + (inc.food ? ' / ' + inc.food + ' 粮' : '') + (inc.troops ? ' / ' + inc.troops + ' 兵' : '') })
          ]),
          el('div', { class: 'kv-item' }, [
            el('div', { class: 'kv-k', text: '升级费用' }),
            el('div', { class: 'kv-v', text: lv >= C.MAX_LEVEL ? '已满级' : util.num(upCost) })
          ])
        ])
      ]);

      var opts = [];
      opts.push({
        label: lv >= C.MAX_LEVEL ? '升级（已满级）' : '升级 Lv' + lv + '→' + (lv + 1) + '（' + util.num(upCost) + '）',
        value: '__up__', cls: 'btn-primary',
        disabled: (lv >= C.MAX_LEVEL || f.gold < upCost) ? 'disabled' : null
      });

      SG.BUILD_LIST.forEach(function (k) {
        if (tile.buildings.indexOf(k) >= 0) return;
        var c = SG.State.buildCost(tile, k);
        opts.push({
          label: '建' + SG.BUILD[k].name + '（' + util.num(c) + '）',
          value: '__b__' + k, cls: '',
          disabled: f.gold < c ? 'disabled' : null
        });
      });
      opts.push({ label: fromLanding ? '完成' : '返回', value: null, cls: 'btn-ghost' });

      var bodyWrap = el('div', {}, [
        body,
        el('p', { class: 'modal-sub', text: '建筑：市集 +30% 金收益／农田 +60 粮／练兵场 +30 兵与守城／护城河 +35% 守城。' })
      ]);

      var pick = await UI.ask({ title: tile.name, sub: '经营 ' + tile.name + '（现有 ' + util.num(f.gold) + ' 金）', body: bodyWrap, options: opts });
      if (pick === null) return;

      if (pick === '__up__') {
        if (doUpgrade(f, tile)) UI.toast(tile.name + ' 升至 Lv' + tile.level, 'good');
      } else if (typeof pick === 'string' && pick.indexOf('__b__') === 0) {
        var key = pick.slice(5);
        if (doBuild(f, tile, key)) UI.toast(tile.name + ' 兴建' + SG.BUILD[key].name, 'good');
      }
      UI.renderAll(state);
    }
  }

  function doUpgrade(f, tile) {
    if (tile.level >= C.MAX_LEVEL) return false;
    var cost = SG.State.upgradeCost(tile);
    if (f.gold < cost) return false;
    f.gold -= cost;
    tile.level++;
    SG.State.log(state, f.name + ' 将 ' + tile.name + ' 升为 Lv' + tile.level + '（费 ' + util.num(cost) + ' 金）。', 'good');
    return true;
  }

  function doBuild(f, tile, key) {
    var cost = SG.State.buildCost(tile, key);
    if (f.gold < cost) return false;
    if (tile.buildings.indexOf(key) >= 0) return false;
    if (tile.buildings.length >= C.MAX_BUILDINGS) return false;
    f.gold -= cost;
    tile.buildings.push(key);
    SG.State.log(state, f.name + ' 于 ' + tile.name + ' 兴建' + SG.BUILD[key].name + '（费 ' + util.num(cost) + ' 金）。', 'good');
    return true;
  }

  async function decideUpgradeAI(f, tile) {
    return SG.AI.answer(state, f, { kind: 'upgrade', tile: tile });
  }

  /* ---- 行动阶段招募 ---- */
  async function menuRecruit(f) {
    var pool = SG.State.freeGenerals(state);
    if (!pool.length) { UI.toast('在野名将已尽', 'bad'); return; }
    await humanRecruitDialog(f, util.sample(pool, Math.min(4, pool.length)), '招募武将');
  }

  /* ---- 委派守将 / 调兵 ---- */
  async function menuAssign(f) {
    var cities = SG.State.citiesOf(state, f.id);
    if (!cities.length) { UI.toast('你还没有城池', 'bad'); return; }

    var body = el('div', {});
    cities.forEach(function (t) {
      var g = t.garrison.generalId ? SG.State.general(state, t.garrison.generalId) : null;
      body.appendChild(el('div', { class: 'general-card' }, [
        el('div', { class: 'gc-portrait', text: g ? g.name.charAt(0) : '空' }),
        el('div', { class: 'gc-main' }, [
          el('div', { class: 'gc-name', text: t.name + '　Lv' + t.level }),
          el('div', { class: 'gc-stats' }, [
            el('span', { html: '守将 <b>' + (g ? g.name : '无') + '</b>' }),
            el('span', { html: '驻军 <b>' + util.num(t.garrison.troops) + '</b>' }),
            el('span', { html: '防御 <b>' + util.num(SG.State.defenseOf(state, t)) + '</b>' })
          ])
        ])
      ]));
    });

    var opts = [{ label: '返回', value: null, cls: 'btn-ghost' }];
    cities.forEach(function (t) { opts.push({ label: t.name, value: t.i, cls: '' }); });

    var idx = await UI.ask({
      title: '委派守将 · 调兵',
      sub: '被攻时以「驻军 + 守将 + 建筑」计算防御力。现有兵力 ' + util.num(f.troops) + '。',
      body: body, options: opts
    });
    if (idx === null) return;
    await assignDialog(f, SG.State.tile(state, idx));
  }

  async function assignDialog(f, tile) {
    while (true) {
      var idle = SG.State.generalsOf(state, f.id).filter(function (g) { return !g.cityId; });
      var other = SG.State.generalsOf(state, f.id).filter(function (g) { return g.cityId && g.cityId !== tile.i; });
      var cur = tile.garrison.generalId ? SG.State.general(state, tile.garrison.generalId) : null;

      var opts = [{ label: '返回', value: null, cls: 'btn-ghost' }];

      idle.concat(other).forEach(function (g) {
        opts.push({
          label: '派 ' + g.name + ' 驻守（武' + g.war + ' 统' + g.lead + '）',
          value: '__g__' + g.id, cls: 'btn-gold'
        });
      });

      [100, 200, 400].forEach(function (n) {
        opts.push({
          label: '增兵 ' + n, value: '__t__' + n, cls: '',
          disabled: f.troops < n ? 'disabled' : null
        });
      });
      var maxT = Math.max(0, f.troops - 60);
      if (maxT >= 100) opts.push({ label: '增兵 ' + util.num(maxT) + '（倾巢）', value: '__t__' + maxT, cls: '', disabled: null });

      var pick = await UI.ask({
        title: tile.name,
        sub: '当前守将 ' + (cur ? cur.name : '无') + '　驻军 ' + util.num(tile.garrison.troops) +
          '　防御 ' + util.num(SG.State.defenseOf(state, tile)) + '　|　可用兵力 ' + util.num(f.troops),
        options: opts
      });
      if (pick === null) return;

      if (typeof pick === 'string' && pick.indexOf('__g__') === 0) {
        var g = SG.State.general(state, pick.slice(5));
        if (g) {
          /* 若原城有其驻守则解除 */
          if (g.cityId) {
            var old = SG.State.tile(state, g.cityId);
            if (old && old.garrison.generalId === g.id) old.garrison.generalId = null;
          }
          /* 顶掉当前守将 */
          if (tile.garrison.generalId) {
            var prev = SG.State.general(state, tile.garrison.generalId);
            if (prev) prev.cityId = null;
          }
          tile.garrison.generalId = g.id;
          g.cityId = tile.i;
          SG.State.log(state, f.name + ' 命 ' + g.name + ' 驻守 ' + tile.name + '。', '');
        }
      } else if (typeof pick === 'string' && pick.indexOf('__t__') === 0) {
        var n = parseInt(pick.slice(5), 10);
        n = Math.min(n, f.troops);
        tile.garrison.troops += n;
        f.troops -= n;
        SG.State.log(state, f.name + ' 向 ' + tile.name + ' 增兵 ' + util.num(n) + '。', '');
      }
      UI.renderAll(state);
    }
  }

  /* ---- 出兵攻城 ---- */
  function siegeTargets(f) {
    var set = {};
    SG.State.citiesOf(state, f.id).forEach(function (t) {
      SG.State.adjacent(state, t.i).forEach(function (i) { set[i] = true; });
    });
    return state.tiles.filter(function (t) {
      return (t.type === T.CITY || t.type === T.PASS) && t.ownerId && t.ownerId !== f.id && set[t.i];
    });
  }

  async function humanSiege(f) {
    var targets = siegeTargets(f);
    if (!targets.length) { UI.toast('相邻之处没有可攻的敌城', 'bad'); return; }

    var g = SG.AI.bestGeneral(state, f);
    var body = el('div', {});
    targets.forEach(function (t) {
      var owner = SG.State.faction(state, t.ownerId);
      var dPower = SG.State.defenseOf(state, t);
      var myPow = SG.AI.powerOf(Math.min(f.troops, 900), g, 1);
      body.appendChild(el('div', { class: 'general-card' }, [
        el('div', { class: 'gc-portrait', text: t.name.charAt(0) }),
        el('div', { class: 'gc-main' }, [
          el('div', { class: 'gc-name', text: t.name + '（' + owner.name + '）　Lv' + Math.max(1, t.level) }),
          el('div', { class: 'gc-stats' }, [
            el('span', { html: '守军 <b>' + util.num(t.garrison.troops) + '</b>' }),
            el('span', { html: '防御 <b>' + util.num(dPower) + '</b>' }),
            el('span', { html: '我方预估 <b>' + util.num(myPow) + '</b>' }),
            el('span', { html: (myPow > dPower ? '<b style="color:#6fae5a">优势</b>' : '<b style="color:#c9483a">劣势</b>') })
          ])
        ])
      ]));
    });

    var opts = [{ label: '返回', value: null, cls: 'btn-ghost' }];
    targets.forEach(function (t) {
      opts.push({ label: '攻打 ' + t.name, value: t.i, cls: 'btn-primary' });
    });

    var idx = await UI.ask({
      title: '出兵攻城',
      sub: '只能攻打与己方城池相邻的敌城。攻城战胜利即可夺城并留兵驻守。<br>主将：' +
        (g ? g.name + '（武' + g.war + ' 统' + g.lead + '）' : '无名校尉') + '　可用兵力 ' + util.num(f.troops),
      body: body, options: opts
    });
    if (idx === null) return;

    var tile = SG.State.tile(state, idx);

    var maxT = Math.max(0, f.troops - 80);
    if (maxT < 100) { UI.toast('兵力不足，无法出兵', 'bad'); return; }

    var amounts = [180, 360, 600, 900, maxT].filter(function (v, i, a) {
      return v >= 100 && v <= maxT && a.indexOf(v) === i;
    }).sort(function (a, b) { return a - b; });

    var opts2 = [{ label: '取消', value: null, cls: 'btn-ghost' }];
    amounts.forEach(function (v) {
      opts2.push({ label: '出兵 ' + util.num(v), value: v, cls: 'btn-primary' });
    });

    var chosen = await UI.ask({
      title: '出兵 ' + tile.name,
      sub: '投入兵力越多，胜算越大；败则残部溃回。现有兵力 ' + util.num(f.troops) + '。',
      options: opts2
    });
    if (chosen === null) return;

    await executeSiege(f, { tileIndex: idx, troops: chosen, generalId: g ? g.id : null });
    UI.renderAll(state);
  }

  async function executeSiege(f, plan) {
    var tile = SG.State.tile(state, plan.tileIndex);
    var owner = SG.State.faction(state, tile.ownerId);
    if (!tile.ownerId || tile.ownerId === f.id) return;

    plan.troops = Math.min(plan.troops, f.troops);
    f.troops -= plan.troops;                            // 开拔（暂离后方）

    var dTroops = Math.max(70, tile.garrison.troops);

    SG.State.log(state, f.name + ' 发兵 ' + util.num(plan.troops) + ' 攻打 ' + owner.name + ' 的 ' + tile.name + '！', 'bad');

    var r = await SG.Battle.run(state, {
      mode: 'siege',
      attackerId: f.id, defenderId: owner.id,
      tileIndex: tile.i,
      aTroops: plan.troops, dTroops: dTroops,
      aGeneralId: plan.generalId,
      dGeneralId: tile.garrison.generalId
    });

    if (r.attackerWins) {
      /* 夺城 */
      var dg = tile.garrison.generalId ? SG.State.general(state, tile.garrison.generalId) : null;
      if (dg) { dg.faction = null; dg.cityId = null; }   // 守将遁走，重归在野
      tile.ownerId = f.id;
      tile.garrison.generalId = plan.generalId;
      tile.garrison.troops = Math.max(0, plan.troops - r.aLoss);
      if (plan.generalId) {
        var ag = SG.State.general(state, plan.generalId);
        if (ag) ag.cityId = tile.i;
      }
      var take = Math.min(owner.gold, r.goldTaken);
      owner.gold -= take;
      f.gold += take;
      SG.State.log(state, '　→ ' + f.name + ' 破城而入，夺取 ' + tile.name + '！掠金 ' + util.num(take) +
        '，留兵 ' + util.num(tile.garrison.troops) + ' 驻守。', 'good');
      UI.toast('攻城得胜，夺取 ' + tile.name + '！', 'good');
    } else {
      /* 溃退：残部返回 */
      tile.garrison.troops = Math.max(0, tile.garrison.troops - r.dLoss);
      var back = Math.max(0, plan.troops - r.aLoss);
      f.troops += back;
      SG.State.log(state, '　→ ' + f.name + ' 攻城失利，折损 ' + util.num(r.aLoss) + ' 众，残部 ' + util.num(back) + ' 退回。', 'bad');
      UI.toast('攻城失败，折损 ' + util.num(r.aLoss) + ' 兵', 'bad');
    }
    UI.renderAll(state);
  }

  /* =========================================================
     AI 行动阶段
     ========================================================= */
  async function aiActions(f) {
    assignGarrisonsAI(f);

    /* 建设 / 升级 */
    var cities = SG.State.citiesOf(state, f.id).filter(function (t) { return t.type === T.CITY; });
    for (var i = 0; i < cities.length; i++) {
      var t = cities[i];
      if (await decideUpgradeAI(f, t)) { doUpgrade(f, t); continue; }
      var choices = SG.BUILD_LIST.filter(function (k) { return t.buildings.indexOf(k) < 0; });
      if (choices.length) {
        var k = await SG.AI.answer(state, f, { kind: 'build', tile: t, choices: choices });
        if (k) doBuild(f, t, k);
      }
    }

    /* 招募 */
    var pool = SG.State.freeGenerals(state);
    if (pool.length) {
      var picks = util.sample(pool, Math.min(4, pool.length));
      var gid = await SG.AI.answer(state, f, {
        kind: 'recruit',
        candidates: picks.map(function (g) { return { general: g, price: SG.State.recruitPrice(state, f, g) }; })
      });
      if (gid) await tryRecruit(f, SG.State.general(state, gid));
    }

    /* 出兵 */
    var plan = await SG.AI.answer(state, f, { kind: 'siege', targets: siegeTargets(f) });
    if (plan) await executeSiege(f, plan);

    UI.renderAll(state);
    await util.delay(180);
  }

  function assignGarrisonsAI(f) {
    var idle = SG.State.generalsOf(state, f.id).filter(function (g) { return !g.cityId; });
    if (!idle.length) return;
    var need = SG.State.citiesOf(state, f.id).filter(function (t) {
      return t.type === T.CITY && !t.garrison.generalId;
    });
    need.sort(function (a, b) { return b.price - a.price; });

    for (var i = 0; i < need.length && idle.length; i++) {
      idle.sort(function (a, b) { return (b.war + b.lead) - (a.war + a.lead); });
      var g = idle.shift();
      var t = need[i];
      var send = Math.min(Math.floor(f.troops * 0.25), Math.max(0, f.troops - 140));
      if (send < 60) send = 0;
      t.garrison.generalId = g.id;
      t.garrison.troops += send;
      f.troops -= send;
      g.cityId = t.i;
    }
  }

  /* =========================================================
     胜负判定与结算
     ========================================================= */
  function checkOutcome() {
    var alive = SG.State.aliveFactions(state);
    if (alive.length === 1) return { type: 'unify', winner: alive[0].id };

    var total = state.tiles.filter(function (t) { return t.type === T.CITY || t.type === T.PASS; }).length;
    for (var i = 0; i < state.factions.length; i++) {
      var f = state.factions[i];
      if (!f.alive) continue;
      if (SG.State.citiesOf(state, f.id).length >= total) return { type: 'unify', winner: f.id };
    }

    if (!SG.State.faction(state, state.playerFactionId).alive) return { type: 'dead' };
    return null;
  }

  function finish(res) {
    if (stale()) return;
    state.over = true;
    state.phase = P.GAME_OVER;
    UI.setBoardActions([]);
    SG.Board.focusPiece(null);
    UI.setTurnBanner('<b>天下大势已定</b>');
    UI.setCenterInfo('本局结束');

    var player = SG.State.faction(state, state.playerFactionId);
    var ranking = state.factions.slice().sort(function (a, b) {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return SG.State.totalAssets(state, b.id) - SG.State.totalAssets(state, a.id);
    });

    var won = false, title = '';
    if (res.type === 'unify') {
      won = res.winner === state.playerFactionId;
      title = won ? '🏆 天下一统 —— 霸业已成！' : '⚔ 天下一统 —— ' + SG.State.faction(state, res.winner).name + ' 一统山河';
    } else if (res.type === 'dead') {
      won = false;
      title = '💀 基业倾覆 —— 势力覆灭';
    } else {
      var top = ranking.filter(function (f) { return f.alive; })[0];
      won = top && top.id === state.playerFactionId;
      title = won ? '💰 富甲天下 —— 你是首富！' : '💰 富甲天下 —— ' + (top ? top.name : '') + ' 富可敌国';
    }

    var body = el('div', {}, [
      el('div', { class: 'card-face', style: { marginBottom: '12px' } }, [
        el('div', { class: 'cf-name', text: title }),
        el('div', { class: 'cf-text', text: '历经 ' + state.round + ' 回合（' + state.scenarioName + '）。' })
      ]),
      el('p', { class: 'modal-sub', text: '最终资产排行（金 + 城池估值 + 兵员估值 + 粮/2）' })
    ]);

    ranking.forEach(function (f, i) {
      body.appendChild(el('div', { class: 'rank-row' }, [
        el('div', { class: 'rank-no', text: String(i + 1) }),
        el('div', { class: 'rank-name', style: { color: f.color }, text: f.name + (f.id === state.playerFactionId ? '（你）' : '') + (f.alive ? '' : ' · 已亡') }),
        el('div', { class: 'rank-val', text: util.num(SG.State.totalAssets(state, f.id)) })
      ]));
    });

    UI.ask({
      title: won ? '🎉 胜' : '败',
      sub: '',
      body: body,
      options: [{ label: '再来一局', value: 'again', cls: 'btn-primary' }, { label: '留在本局查看', value: null, cls: 'btn-ghost' }]
    }).then(function (v) {
      if (v === 'again') { SG.State.clearSave(); if (onEnd) onEnd({ restart: true }); }
    });
  }

  function stop() { stopped = true; }
  function isPlayer(f) { return f.id === state.playerFactionId; }

  /* =========================================================
     对外接口
     ========================================================= */
  SG.Engine = {
    init: init,
    start: start,
    continueGame: continueGame,
    stop: stop,
    getState: function () { return state; },
    siegeTargets: siegeTargets,
    occupy: occupy
  };

})();
