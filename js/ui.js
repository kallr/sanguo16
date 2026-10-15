/* =========================================================
   ui.js —— 开局界面 / 侧栏 / 日志 / 弹窗 / 卡牌与武将展示
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util, el = SG.el, $ = SG.$;

  var state = null;

  /* =========================================================
     通用：Toast
     ========================================================= */
  function toast(text, cls) {
    var box = $('#toastBox');
    if (!box) return;
    var node = el('div', { class: 'toast ' + (cls || ''), text: text });
    box.appendChild(node);
    setTimeout(function () {
      node.style.transition = 'opacity .3s';
      node.style.opacity = '0';
      setTimeout(function () { node.remove(); }, 320);
    }, 1900);
  }

  /* =========================================================
     通用：弹窗
     ask({ title, sub, body, options:[{label,value,cls}], dismissable })
     返回 Promise（resolve 所选 value；无可选项则 resolve(true)）
     ========================================================= */
  var overlay, modal;
  function ask(o) {
    return new Promise(function (resolve) {
      o = o || {};
      var body = o.body;
      /* 统一包进 .modal-body，保证正文可滚动、底部按钮区始终可见 */
      var bodyNode = el('div', { class: 'modal-body' });
      if (body instanceof Node) bodyNode.appendChild(body);
      else bodyNode.innerHTML = body || '';

      var acts = el('div', { class: 'modal-actions' });
      var opts = o.options || [{ label: '确定', value: true, cls: 'btn-primary' }];

      var closed = false;
      function close(v) {
        if (closed) return;
        closed = true;
        overlay.classList.add('hidden');
        SG.clear(modal);
        resolve(v);
      }

      opts.forEach(function (op) {
        acts.appendChild(el('button', {
          class: 'btn ' + (op.cls || ''),
          text: op.label,
          disabled: op.disabled ? 'disabled' : null,
          onclick: function () { close(op.value); }
        }));
      });

      SG.clear(modal);
      modal.appendChild(el('h2', { class: 'modal-title', text: o.title || '' }));
      if (o.sub) modal.appendChild(el('p', { class: 'modal-sub', html: o.sub }));
      modal.appendChild(bodyNode);
      modal.appendChild(acts);

      overlay.classList.remove('hidden');
    });
  }

  function confirm(title, html, okLabel, cancelLabel) {
    return ask({
      title: title,
      body: html,
      options: [
        { label: cancelLabel || '取消', value: false, cls: 'btn-ghost' },
        { label: okLabel || '确定', value: true, cls: 'btn-primary' }
      ]
    });
  }

  function info(title, html, btnLabel) {
    return ask({
      title: title,
      body: html,
      options: [{ label: btnLabel || '知道了', value: true, cls: 'btn-primary' }]
    });
  }

  /* 卡牌弹窗 */
  function showCard(card, factionName) {
    var node = el('div', { class: 'card-face' }, [
      el('div', { class: 'cf-icon', text: card.icon || '📜' }),
      el('div', { class: 'cf-name', text: card.name }),
      el('div', { class: 'cf-text', text: card.text })
    ]);
    return ask({
      title: (card.kind === 'chance' ? '机会' : '事件') + '　·　' + (factionName || ''),
      sub: '时也命也，且看此番际遇——',
      body: node,
      options: [{ label: '听天由命', value: true, cls: 'btn-gold' }]
    });
  }

  /* 文本框弹窗（导入/导出存档用） */
  function textBoxDialog(title, sub, value, readOnly) {
    var ta = el('textarea', {
      style: {
        width: '100%', height: '180px', background: '#141009', color: '#e9dcc4',
        border: '1px solid #453723', borderRadius: '8px', padding: '10px',
        fontFamily: 'monospace', fontSize: '12px', resize: 'vertical'
      }
    });
    ta.value = value || '';
    if (readOnly) ta.readOnly = true;
    return ask({
      title: title,
      sub: sub,
      body: ta,
      options: readOnly
        ? [{ label: '关闭', value: null, cls: 'btn-ghost' }]
        : [
            { label: '取消', value: null, cls: 'btn-ghost' },
            { label: '确定导入', value: '__ok__', cls: 'btn-primary' }
          ]
    }).then(function () { return readOnly ? null : ta.value; });
  }

  /* =========================================================
     侧栏：势力面板
     ========================================================= */
  function renderFactions(st) {
    var box = $('#factionList');
    if (!box) return;
    SG.clear(box);

    st.factions.forEach(function (f) {
      var isPlayer = f.id === st.playerFactionId;
      var cities = SG.State.citiesOf(st, f.id).length;
      var gens = SG.State.generalsOf(st, f.id).length;

      var card = el('div', {
        class: 'faction-card' + (st.currentFactionId === f.id ? ' current' : '') + (f.alive ? '' : ' dead'),
        style: { '--fc': f.color }
      }, [
        el('div', { class: 'fc-head' }, [
          el('div', { class: 'fc-name', text: f.name + (isPlayer ? '（你）' : '') }),
          el('div', { class: 'fc-tag', text: f.alive ? (isPlayer ? '主公' : '电脑') : '已亡' })
        ]),
        el('div', { class: 'fc-res' }, [
          el('span', { html: '金 <b>' + util.num(f.gold) + '</b>' }),
          el('span', { html: '粮 <b>' + util.num(f.food) + '</b>' }),
          el('span', { html: '兵 <b>' + util.num(f.troops) + '</b>' })
        ]),
        el('div', { class: 'fc-bar' }, [
          el('span', { text: '城 ' + cities }),
          el('span', { text: '将 ' + gens }),
          el('span', { text: '『' + f.perk.name + '』' + f.perk.desc })
        ])
      ]);
      box.appendChild(card);
    });
  }

  /* =========================================================
     侧栏：日志
     ========================================================= */
  function appendLog(entry) {
    var box = $('#logList');
    if (!box) return;
    var node = el('div', { class: 'log-item ' + (entry.cls || ''), html: entry.t });
    box.appendChild(node);
    box.scrollTop = box.scrollHeight;
    while (box.childElementCount > 200) box.removeChild(box.firstChild);
  }

  function resetLog(st) {
    var box = $('#logList');
    if (!box) return;
    SG.clear(box);
    (st.log || []).forEach(appendLog);
  }

  /* =========================================================
     顶部与棋盘中央
     ========================================================= */
  function renderTop(st) {
    var cs = $('#chipScenario');
    var cr = $('#chipRound');
    if (cs) cs.textContent = st.scenarioName + '　' + st.maxRound + ' 回合';
    if (cr) cr.textContent = '第 ' + st.round + ' 回合　（' + st.turn + ' 手）';
  }

  function setTurnBanner(html) {
    var n = $('#turnBanner');
    if (n) n.innerHTML = html;
  }

  function setCenterInfo(html) { SG.Board.setCenterInfo(html); }
  function setBoardActions(nodes) { SG.Board.setBoardActions(nodes); }

  /* 整体刷新 */
  function renderAll(st) {
    state = st;
    renderTop(st);
    renderFactions(st);
    SG.Board.render();
    SG.Board.syncPieces();
    SG.Board.focusPiece(st.currentFactionId);
  }

  /* =========================================================
     武将卡片
     ========================================================= */
  function generalCard(g, st, fid) {
    var f = SG.State.faction(st, fid);
    var aff = SG.State.affinityTo(st, f, g);
    var price = SG.State.recruitPrice(st, f, g);

    var affColor = aff >= 70 ? '#6fae5a' : (aff >= 45 ? '#e0a13c' : '#c9483a');
    var affText = aff >= 80 ? '一见如故' : aff >= 60 ? '颇为投缘' : aff >= 45 ? '尚可一谈' : '话不投机';

    return el('div', { class: 'general-card' }, [
      el('div', { class: 'gc-portrait', text: g.avatar || g.name.charAt(0) }),
      el('div', { class: 'gc-main' }, [
        el('div', { class: 'gc-name', text: g.name + (g.title ? '　字 ' + g.title : '') }),
        el('div', { class: 'gc-stats' }, [
          el('span', { html: '武 <b>' + g.war + '</b>' }),
          el('span', { html: '智 <b>' + g.intel + '</b>' }),
          el('span', { html: '统 <b>' + g.lead + '</b>' }),
          el('span', { html: '俸 <b>' + g.salary + '</b>' })
        ]),
        el('div', { class: 'gc-aff', style: { color: affColor }, text: '相性 ' + aff + '　' + affText })
      ]),
      el('div', { class: 'gc-right' }, [
        el('div', { class: 'gc-cost', text: util.num(price) + ' 金' })
      ])
    ]);
  }

  /* =========================================================
     开局界面
     ========================================================= */
  var startSel = { scenario: 'qunxiong', faction: 'liubei', ai: 2, pace: 'normal' };

  function buildStartScreen() {
    /* 剧本 */
    var sp = $('#scenarioPick');
    if (sp) {
      SG.clear(sp);
      SG.data.SCENARIOS.forEach(function (sc) {
        var c = el('div', {
          class: 'pick-card' + (startSel.scenario === sc.id ? ' active' : ''),
          dataset: { key: sc.id },
          onclick: function () { startSel.scenario = sc.id; buildStartScreen(); }
        }, [
          el('div', { class: 'pc-name', text: sc.icon + ' ' + sc.name }),
          el('div', { class: 'pc-desc', text: sc.desc + '（' + sc.maxRound + ' 回合）' })
        ]);
        c.style.borderLeftColor = '#d9b26a';
        sp.appendChild(c);
      });
    }

    /* 势力 */
    var fp = $('#factionPick');
    if (fp) {
      SG.clear(fp);
      SG.data.FACTIONS.forEach(function (f) {
        var c = el('div', {
          class: 'pick-card' + (startSel.faction === f.id ? ' active' : ''),
          onclick: function () { startSel.faction = f.id; buildStartScreen(); }
        }, [
          el('div', { class: 'pc-name', text: '『' + f.lord + '』' }),
          el('div', { class: 'pc-desc', text: f.perk.name + '：' + f.perk.desc })
        ]);
        c.style.borderLeftColor = f.color;
        fp.appendChild(c);
      });
    }

    /* 电脑数量 */
    var ap = $('#aiPick');
    if (ap) {
      SG.clear(ap);
      [1, 2, 3].forEach(function (n) {
        ap.appendChild(el('div', {
          class: 'pick-card small' + (startSel.ai === n ? ' active' : ''),
          onclick: function () { startSel.ai = n; buildStartScreen(); }
        }, [
          el('div', { class: 'pc-name', text: '1 对 ' + n }),
          el('div', { class: 'pc-desc', text: '场上共 ' + (n + 1) + ' 方势力' })
        ]));
      });
    }

    /* 节奏 */
    var pp = $('#pacePick');
    if (pp) {
      SG.clear(pp);
      Object.keys(SG.data.PACES).forEach(function (k) {
        var p = SG.data.PACES[k];
        pp.appendChild(el('div', {
          class: 'pick-card small' + (startSel.pace === k ? ' active' : ''),
          onclick: function () { startSel.pace = k; buildStartScreen(); }
        }, [
          el('div', { class: 'pc-name', text: p.name }),
          el('div', { class: 'pc-desc', text: p.desc })
        ]));
      });
    }

    /* 存档按钮可用性 */
    var load = $('#btnLoadGame');
    var hint = $('#startHint');
    if (load) {
      var has = SG.State.hasSave();
      load.disabled = !has;
      if (hint) hint.textContent = has ? '检测到本地存档，可继续上一局。' : '暂无本地存档。';
    }
  }

  function showStart() { $('#startScreen').classList.remove('hidden'); $('#app').classList.add('hidden'); buildStartScreen(); }
  function hideStart() { $('#startScreen').classList.add('hidden'); $('#app').classList.remove('hidden'); }

  /* =========================================================
     玩法说明
     ========================================================= */
  function helpHTML() {
    return [
      '<p><b>目标</b>：占领全部城池即「统一天下」直接获胜；若打到回合上限，则总资产（金 + 城池估值 + 兵员估值 + 粮/2）最高者胜。</p>',
      '<p><b>回合流程</b>：收城池收益 → 掷骰 → 逐格移动 → 落地结算 → 自由行动 → 结束回合。</p>',
      '<p><b>落地结算</b></p>',
      '<ul style="margin:4px 0 10px;padding-left:18px;line-height:1.8">',
      '<li>空地：花金<b>占领</b>（城池/关隘）；</li>',
      '<li>己方城池：<b>升级</b>（最高 Lv5）、<b>建设</b>（市集/农田/练兵场/护城河）；</li>',
      '<li>敌方城池：<b>交税</b> 或 <b>宣战</b>（野战：胜则免过路费并掠夺，败则付双倍）；</li>',
      '<li>农田格：领 200 粮；招贤馆：招募在野名将；事件/机会格：抽卡。</li>',
      '</ul>',
      '<p><b>出战与夺城</b>：行动阶段可「出兵」攻打<b>相邻</b>敌城（攻城战），胜利即夺城。守军乏力时更易得手。</p>',
      '<p><b>相性</b>：招募名将看「合不合得来」。心仪你势力的名将（如诸葛亮之于刘备）成功率极高，反之话不投机。</p>',
      '<p><b>联片加成</b>：同一地域占有 3 城以上，该地域所有城池收益 +15%。</p>',
      '<p><b>兵粮</b>：每回合按兵力消耗粮草（每 10 兵耗 1 粮），粮草不足则士兵逃亡。</p>'
    ].join('');
  }

  /* =========================================================
     初始化
     ========================================================= */
  function init() {
    overlay = $('#overlay');
    modal = $('#modal');

    SG.bus.on('log', function (entry) { appendLog(entry); });

    return { startSel: startSel, buildStartScreen: buildStartScreen };
  }

  SG.UI = {
    init: init,
    toast: toast,
    ask: ask,
    confirm: confirm,
    info: info,
    showCard: showCard,
    textBoxDialog: textBoxDialog,
    renderAll: renderAll,
    renderFactions: renderFactions,
    renderTop: renderTop,
    appendLog: appendLog,
    resetLog: resetLog,
    setTurnBanner: setTurnBanner,
    setCenterInfo: setCenterInfo,
    setBoardActions: setBoardActions,
    generalCard: generalCard,
    helpHTML: helpHTML,
    showStart: showStart,
    hideStart: hideStart,
    buildStartScreen: buildStartScreen,
    startSel: startSel
  };

})();
