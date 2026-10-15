/* =========================================================
   data.generals.js —— 武将表
   字段：id / name / title(字) / faction(初始归属，null=在野) /
        war 武力 / intel 智力 / lead 统率 / pref 相性倾向势力 /
        salary 俸禄(每回合) / avatar 头像(emoji 兜底)
   相性(pref)：招募时用于「合不合得来」的判定，刘备易得诸葛亮。
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  SG.data = SG.data || {};

  var seq = 0;
  function G(name, title, faction, war, intel, lead, pref) {
    seq++;
    return {
      id: 'g' + (seq < 10 ? '0' + seq : seq),
      name: name,
      title: title,
      faction: faction || null,
      war: war,
      intel: intel,
      lead: lead,
      pref: pref || null,
      salary: Math.max(15, Math.round((war + intel + lead) / 6)),
      avatar: ''
    };
  }

  SG.data.GENERALS = [
    /* ---- 开局归属 ---- */
    G('关羽',    '云长', 'liubei',  98, 78, 92, 'liubei'),
    G('张飞',    '翼德', 'liubei',  96, 32, 80, 'liubei'),
    G('夏侯惇',  '元让', 'caocao',  88, 68, 85, 'caocao'),
    G('夏侯渊',  '妙才', 'caocao',  85, 62, 82, 'caocao'),
    G('周瑜',    '公瑾', 'sunquan', 76, 96, 90, 'sunquan'),
    G('黄盖',    '公覆', 'sunquan', 80, 66, 78, 'sunquan'),
    G('华雄',    '',     'dongzhuo',88, 40, 70, 'dongzhuo'),
    G('李儒',    '',     'dongzhuo',25, 92, 70, 'dongzhuo'),

    /* ---- 在野名将（招贤馆可招募）---- */
    G('吕布',    '奉先', 'dongzhuo',100, 28, 88, 'dongzhuo'),
    G('赵云',    '子龙', 'liubei',  97, 76, 90, 'liubei'),
    G('诸葛亮',  '孔明', 'liubei',  55,100, 92, 'liubei'),
    G('马超',    '孟起', 'liubei',  96, 60, 85, 'liubei'),
    G('黄忠',    '汉升', 'liubei',  92, 62, 80, 'liubei'),
    G('魏延',    '文长', 'liubei',  88, 58, 76, 'liubei'),
    G('姜维',    '伯约', 'liubei',  90, 84, 86, 'liubei'),
    G('庞统',    '士元', 'liubei',  45, 97, 78, 'liubei'),
    G('法正',    '孝直', 'liubei',  40, 92, 74, 'liubei'),
    G('张辽',    '文远', 'caocao',  92, 78, 88, 'caocao'),
    G('许褚',    '仲康', 'caocao',  93, 36, 72, 'caocao'),
    G('典韦',    '',     'caocao',  95, 30, 70, 'caocao'),
    G('徐晃',    '公明', 'caocao',  88, 72, 84, 'caocao'),
    G('郭嘉',    '奉孝', 'caocao',  32, 96, 80, 'caocao'),
    G('荀彧',    '文若', 'caocao',  30, 94, 82, 'caocao'),
    G('司马懿',  '仲达', 'caocao',  60, 98, 92, 'caocao'),
    G('张郃',    '儁乂', 'caocao',  85, 74, 82, 'caocao'),
    G('于禁',    '文则', 'caocao',  80, 66, 82, 'caocao'),
    G('乐进',    '文谦', 'caocao',  78, 54, 74, 'caocao'),
    G('吕蒙',    '子明', 'sunquan', 78, 84, 86, 'sunquan'),
    G('甘宁',    '兴霸', 'sunquan', 90, 60, 78, 'sunquan'),
    G('太史慈',  '子义', 'sunquan', 92, 66, 80, 'sunquan'),
    G('陆逊',    '伯言', 'sunquan', 70, 94, 90, 'sunquan'),
    G('鲁肃',    '子敬', 'sunquan', 40, 90, 78, 'sunquan'),
    G('孙策',    '伯符', 'sunquan', 94, 72, 88, 'sunquan'),
    G('程普',    '德谋', 'sunquan', 82, 70, 80, 'sunquan'),
    G('韩当',    '义公', 'sunquan', 80, 58, 76, 'sunquan'),
    G('颜良',    '',     null,      90, 30, 72, null),
    G('文丑',    '',     null,      89, 28, 70, null),
    G('袁绍',    '本初', null,      70, 68, 84, null),
    G('张绣',    '',     'dongzhuo',86, 54, 72, 'dongzhuo'),
    G('张角',    '',     null,      45, 88, 76, null),
    G('公孙瓒',  '伯圭', null,      82, 56, 78, null),
    G('貂蝉',    '',     'dongzhuo',36, 88, 60, 'dongzhuo'),
    G('蔡瑁',    '德珪', null,      66, 68, 70, null),
    G('纪灵',    '',     null,      82, 50, 70, null)
  ];

  /* 招募基础价：武力与智力越高越贵 */
  SG.data.generalPrice = function (g) {
    return Math.round((g.war * 12 + g.intel * 14 + g.lead * 8) * 1.35 / 10) * 10;
  };

  /* 相性评分 0~100：倾向势力契合 + 名望加成 */
  SG.data.affinity = function (g, factionId) {
    var score = 46;
    if (!g.pref) score += 6;            // 无倾向者更好说话
    else if (g.pref === factionId) score += 38; // 正是心仪之主
    else score -= 22;                   // 心有所属，难挖
    var fame = (g.war + g.intel + g.lead) / 3;
    score += Math.round((60 - fame) / 6); // 名望越高越傲气，略降
    return SG.util.clamp(score, 5, 96);
  };

})();
