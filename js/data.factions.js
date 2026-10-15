/* =========================================================
   data.factions.js —— 可选势力（君主）表
   perk 由引擎按 key 结算：
     renDe   仁德 —— 招募费用 -20%，相性判定 +10
     tunTian 屯田 —— 农田建筑产粮 +30%
     jiangDong 江东 —— 江东地域城池收益 +20%
     baoNue  暴虐 —— 战斗掠夺 +50%，初始兵力 +300，过路费收入 -15%
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  SG.data = SG.data || {};

  SG.data.FACTIONS = [
    {
      id: 'liubei', name: '刘备', lord: '刘备', color: '#4a9e6a',
      desc: '仁德布于四海，贤才乐为所用。',
      perk: { key: 'renDe', name: '仁德', desc: '招募费用 -20%，相性判定 +10' },
      gold: 2400, food: 1200, troops: 600,
      capital: 32,                 // 平原
      generals: ['关羽', '张飞']
    },
    {
      id: 'caocao', name: '曹操', lord: '曹操', color: '#4a7ab5',
      desc: '挟天子以令诸侯，屯田积谷，兵精粮足。',
      perk: { key: 'tunTian', name: '屯田', desc: '农田建筑产粮 +30%' },
      gold: 2600, food: 1400, troops: 650,
      capital: 3,                  // 陈留
      generals: ['夏侯惇', '夏侯渊']
    },
    {
      id: 'sunquan', name: '孙权', lord: '孙权', color: '#b5473f',
      desc: '据江东六郡，水军冠绝天下。',
      perk: { key: 'jiangDong', name: '江东', desc: '江东地域城池收益 +20%' },
      gold: 2500, food: 1300, troops: 620,
      capital: 17,                 // 吴郡
      generals: ['周瑜', '黄盖']
    },
    {
      id: 'dongzhuo', name: '董卓', lord: '董卓', color: '#8a6bbf',
      desc: '西凉铁骑，骁勇善战，然暴虐失人心。',
      perk: { key: 'baoNue', name: '暴虐', desc: '战斗掠夺 +50%，初始兵力 +300，过路费收入 -15%' },
      gold: 2200, food: 1100, troops: 900,
      capital: 1,                  // 洛阳
      generals: ['华雄', '李儒']
    }
  ];

  SG.data.FACTION_ORDER = ['liubei', 'caocao', 'sunquan', 'dongzhuo'];

  SG.data.factionById = function (id) {
    for (var i = 0; i < SG.data.FACTIONS.length; i++) {
      if (SG.data.FACTIONS[i].id === id) return SG.data.FACTIONS[i];
    }
    return null;
  };

})();
