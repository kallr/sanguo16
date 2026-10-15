/* =========================================================
   battle.js —— 战斗解算与演出
   三种模式：
     duel  单挑（作为野战/攻城的前置，胜者提振全军）
     field 野战（路过敌城时「宣战」触发，不能夺城）
     siege 攻城战（行动阶段「出兵」触发，胜可夺城）
   分工：compute() 只算不写状态；引擎拿到结果后再结算影响。
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util, el = SG.el;

  /* ---------- 武将战力取值 ---------- */
  function gstat(g, key, dflt) { return g ? g[key] : dflt; }

  /* ---------- 计算一场战斗 ---------- */
  function compute(state, o) {
    var aF = SG.State.faction(state, o.attackerId);
    var dF = SG.State.faction(state, o.defenderId);
    var aG = o.aGeneralId ? SG.State.general(state, o.aGeneralId) : null;
    var dG = o.dGeneralId ? SG.State.general(state, o.dGeneralId) : null;
    var tile = o.tileIndex != null ? SG.State.tile(state, o.tileIndex) : null;

    /* --- 1) 单挑 --- */
    var aWar = gstat(aG, 'war', 30) + util.rand(-9, 9);
    var dWar = gstat(dG, 'war', 30) + util.rand(-9, 9);
    var duelWinner = aWar >= dWar ? 'a' : 'd';
    var moraleA = duelWinner === 'a' ? 1.18 : 0.86;
    var moraleD = duelWinner === 'd' ? 1.18 : 0.86;

    /* --- 2) 守城加成 --- */
    var defBonus = 1;
    if (o.mode === 'siege' && tile) {
      defBonus = 1 + 0.15 * Math.max(0, tile.level - 1)
        + 0.25 * SG.State.buildingsOf(tile, 'drill')
        + 0.35 * SG.State.buildingsOf(tile, 'moat');
    }

    /* --- 3) 战力 --- */
    var aForce = o.aTroops * (1 + gstat(aG, 'lead', 40) / 200 + gstat(aG, 'war', 30) / 500)
      * moraleA * util.rand(0.88, 1.12);
    var dForce = o.dTroops * (1 + gstat(dG, 'lead', 40) / 200 + gstat(dG, 'war', 30) / 500)
      * defBonus * moraleD * util.rand(0.88, 1.12);

    var attackerWins = aForce >= dForce;
    var ratio = Math.max(aForce, dForce) / Math.max(1, Math.min(aForce, dForce));

    var loserLoss = util.clamp(0.45 + (ratio - 1) * 0.40, 0.30, 0.92);
    var winnerLoss = util.clamp(0.18 / ratio, 0.04, 0.50);

    var aLoss = Math.round(o.aTroops * (attackerWins ? winnerLoss : loserLoss));
    var dLoss = Math.round(o.dTroops * (attackerWins ? loserLoss : winnerLoss));

    /* --- 4) 掠夺 --- */
    var goldTaken = 0;
    if (attackerWins) {
      var pool = tile ? SG.State.tollOf(state, tile) * 2 : 0;
      goldTaken = Math.round(Math.min(dF.gold, Math.max(180, pool)));
      if (aF.perk.key === 'baoNue') goldTaken = Math.round(goldTaken * 1.5);
    } else {
      goldTaken = 0;
    }

    /* --- 5) 战报文字 --- */
    var rounds = [];
    rounds.push({
      t: '【单挑】' + (aG ? aG.name : '无名校尉') + '（武' + gstat(aG, 'war', 30) + '） 对阵 ' +
        (dG ? dG.name : '无名守将') + '（武' + gstat(dG, 'war', 30) + '）',
      cls: ''
    });
    rounds.push({
      t: duelWinner === 'a'
        ? '　→ 单挑得手！' + (aG ? aG.name : '攻方主将') + ' 斩将夺旗，全军士气大振。'
        : '　→ 单挑失利…' + (dG ? dG.name : '守方主将') + ' 力挫敌锋，攻方锐气受挫。',
      cls: duelWinner === 'a' ? 'crit' : ''
    });
    rounds.push({
      t: '【交锋】攻方战力 ' + Math.round(aForce) + '　vs　守方战力 ' + Math.round(dForce) +
        (o.mode === 'siege' ? '（含守城加成 ' + Math.round((defBonus - 1) * 100) + '%）' : ''),
      cls: 'hit'
    });
    rounds.push({
      t: attackerWins
        ? '　→ 攻方破阵！敌军溃散，折损 ' + util.num(dLoss) + ' 众。'
        : '　→ 攻方溃退！折损 ' + util.num(aLoss) + ' 众。',
      cls: attackerWins ? 'crit' : ''
    });

    return {
      mode: o.mode,
      attackerId: o.attackerId,
      defenderId: o.defenderId,
      tileIndex: o.tileIndex,
      aTroops: o.aTroops,
      dTroops: o.dTroops,
      aGeneralId: o.aGeneralId || null,
      dGeneralId: o.dGeneralId || null,
      aForce: Math.round(aForce),
      dForce: Math.round(dForce),
      duelWinner: duelWinner,
      winner: attackerWins ? o.attackerId : o.defenderId,
      attackerWins: attackerWins,
      aLoss: aLoss,
      dLoss: dLoss,
      goldTaken: goldTaken
    };
  }

  /* ---------- 演出 ---------- */
  function play(state, r) {
    var layer = SG.$('#battleLayer');
    if (!layer) return Promise.resolve();

    var aF = SG.State.faction(state, r.attackerId);
    var dF = SG.State.faction(state, r.defenderId);
    var aG = r.aGeneralId ? SG.State.general(state, r.aGeneralId) : null;
    var dG = r.dGeneralId ? SG.State.general(state, r.dGeneralId) : null;
    var title = { duel: '单挑', field: '野战', siege: '攻城战' }[r.mode] || '交战';

    var total = r.aForce + r.dForce;
    var aPct = Math.round(r.aForce / Math.max(1, total) * 100);

    var logBox = el('div', { class: 'bs-log' });
    var resultLine = el('div', { class: 'bs-result' });
    var actions = el('div', { class: 'bs-actions' });

    var aHp = el('i', { style: { width: '100%' } });
    var dHp = el('i', { style: { width: '100%' } });

    var stage = el('div', { class: 'battle-stage' }, [
      el('div', { class: 'bs-title', text: '⚔ ' + title + '　' + (r.tileIndex != null ? SG.State.tile(state, r.tileIndex).name : '') }),
      el('div', { class: 'bs-rows' }, [
        el('div', { class: 'bs-side att' }, [
          el('div', { class: 'bs-who', style: { color: aF.color }, text: '攻　' + aF.name }),
          el('div', { class: 'bs-hero', text: '主将 ' + (aG ? aG.name : '无名校尉') + '　兵 ' + util.num(r.aTroops) }),
          el('div', { class: 'bs-hp' }, [aHp]),
          el('div', { class: 'bs-force', text: util.num(r.aForce) })
        ]),
        el('div', { class: 'bs-vs', text: 'VS' }),
        el('div', { class: 'bs-side def' }, [
          el('div', { class: 'bs-who', style: { color: dF.color }, text: '守　' + dF.name }),
          el('div', { class: 'bs-hero', text: '主将 ' + (dG ? dG.name : '无名守将') + '　兵 ' + util.num(r.dTroops) }),
          el('div', { class: 'bs-hp def' }, [dHp]),
          el('div', { class: 'bs-force', text: util.num(r.dForce) })
        ])
      ]),
      logBox, resultLine, actions
    ]);

    SG.clear(layer);
    layer.appendChild(stage);
    layer.classList.remove('hidden');

    /* 日志逐条播放 */
    var i = 0;
    function nextLine() {
      if (i >= r.rounds.length) return Promise.resolve();
      var item = el('div', { class: r.rounds[i].cls || '', text: r.rounds[i].t });
      logBox.appendChild(item);
      logBox.scrollTop = logBox.scrollHeight;
      i++;
      return util.delay(560).then(nextLine);
    }

    var involvePlayer = (r.attackerId === state.playerFactionId || r.defenderId === state.playerFactionId);

    return nextLine().then(function () {
      /* 血条动画 */
      if (r.attackerWins) {
        dHp.style.width = Math.max(4, 100 - aPct) + '%';
        aHp.style.width = '82%';
      } else {
        aHp.style.width = Math.max(4, aPct * 0.45) + '%';
        dHp.style.width = '78%';
      }
      resultLine.className = 'bs-result ' + (r.attackerWins ? 'win' : 'lose');
      var winnerF = SG.State.faction(state, r.winner);
      resultLine.textContent = '『 ' + winnerF.name + ' 胜 』' + (r.goldTaken ? '　掠得金 ' + util.num(r.goldTaken) : '');

      return new Promise(function (resolve) {
        if (involvePlayer) {
          actions.appendChild(el('button', {
            class: 'btn btn-primary', text: '继续',
            onclick: function () { layer.classList.add('hidden'); resolve(); }
          }));
        } else {
          setTimeout(function () { layer.classList.add('hidden'); resolve(); }, 1100);
        }
      });
    });
  }

  /* ---------- 对外：算 + 演 ---------- */
  function run(state, opts) {
    var r = compute(state, opts);
    return play(state, r).then(function () { return r; });
  }

  SG.Battle = { compute: compute, play: play, run: run };

})();
