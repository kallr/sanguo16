/* =========================================================
   data.scenarios.js —— 剧本（分幕）
   对局节奏 pace 会再乘算 maxRound：快 0.7 / 标准 1 / 持久 1.5
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  SG.data = SG.data || {};

  SG.data.SCENARIOS = [
    {
      id: 'huangjin', name: '黄巾之乱', icon: '🟡',
      desc: '乱世初起，四方凋敝。起始钱粮微薄，适合熟悉规则。',
      maxRound: 40,
      mul: { gold: 0.8, food: 0.8, troops: 0.8 },
      aiMul: { gold: 0.8, food: 0.8, troops: 0.8 },
      aiSkill: 0.9
    },
    {
      id: 'qunxiong', name: '群雄割据', icon: '⚔️',
      desc: '群雄并起，逐鹿中原。标准开局，推荐首选。',
      maxRound: 50,
      mul: { gold: 1, food: 1, troops: 1 },
      aiMul: { gold: 1, food: 1, troops: 1 },
      aiSkill: 1
    },
    {
      id: 'yitong', name: '一统中原', icon: '🏯',
      desc: '诸侯坐大，强敌环伺。电脑势力开局更为雄厚。',
      maxRound: 60,
      mul: { gold: 1, food: 1, troops: 1 },
      aiMul: { gold: 1.25, food: 1.25, troops: 1.25 },
      aiSkill: 1.12
    },
    {
      id: 'fujia', name: '富甲天下', icon: '💰',
      desc: '天下承平，比的是家底。钱粮丰厚，长线经营。',
      maxRound: 70,
      mul: { gold: 1.4, food: 1.4, troops: 1.2 },
      aiMul: { gold: 1.25, food: 1.25, troops: 1.15 },
      aiSkill: 1.05
    }
  ];

  SG.data.PACES = {
    fast:   { key: 'fast',   name: '速战',  desc: '回合数 x0.7，节奏紧凑', mul: 0.7 },
    normal: { key: 'normal', name: '标准',  desc: '默认回合数',           mul: 1 },
    long:   { key: 'long',   name: '持久',  desc: '回合数 x1.5，慢火经营', mul: 1.5 }
  };

  SG.data.scenarioById = function (id) {
    for (var i = 0; i < SG.data.SCENARIOS.length; i++) {
      if (SG.data.SCENARIOS[i].id === id) return SG.data.SCENARIOS[i];
    }
    return SG.data.SCENARIOS[1];
  };

})();
