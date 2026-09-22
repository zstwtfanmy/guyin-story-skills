const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sPlaces = ['官道旁的野店', '岔路口的石碑', '旧茶棚底下', '土地庙廊下', '河湾边浅滩',
  '黄土坡脊背', '柳树林尽头', '野渡口木桩', '石桥头缆绳', '集市口面摊', '山坳里独屋', '苇荡深处',
  '废窑场窑口', '枣树林坟岗', '旱河床卵石', '县城北门洞', '骡马市槽头', '盐栈月台',
  '烽火台残基', '竹林小径'];
const sActs = ['就着', '绕过', '避开', '打听', '辞别', '挤过', '望见', '歇过', '蹚过', '辨认',
  '躲过', '赶上', '翻过', '贴着', '迎着', '沿着'];
const sThings = ['半块干饼', '驮货的骡队', '收摊小贩', '生锈路标', '结冰浅水', '塌方崖根',
  '飘幡野店', '摆渡空船', '守城老兵', '炊饼担子', '斜倒石碑', '没膝荒草', '褪色幡布',
  '干裂水桶', '粗瓷大碗', '补丁褡裢', '火镰绒草', '桐油斗笠', '麻绳包裹', '桑木扁担'];
const sSubjects = ['少年', '后生', '赶脚的', '年轻人', '背包袱的', '行脚人'];
const sMoods = ['不吭声只赶路', '反复掂量那封短信', '把包袱往肩上提提', '盯远处城郭',
  '记住来路弯口', '喝口凉水', '算着剩余脚程', '听路人说行情', '提防尾随人影', '闻炊烟才觉饿',
  '摸了摸怀里信笺', '数着腰间铜钱', '打量沿途脚印', '把斗笠压低些'];
const sDirs = ['北', '东', '城关', '州府', '渡口', '山里'];
const sTimes = ['日头偏到山后', '晨雾还没散尽', '河风裹沙打脸', '远处传来犬吠',
  '云压得像要落雪', '茶旗无精打采', '渡钟敲了五下', '归鸟掠过头顶', '霜结在枯草上',
  '骡铃顺风飘远', '暮色漫进田埂', '残月挂在林梢', '早星稀稀落落', '晨霜踩出碎响'];
const sTails = ['谁也猜不透信里写了什么', '他把这桩事压在心底', '沿途动静都被记牢',
  '脚下半步不敢迟疑', '怀里那点盘缠攥得发烫', '店伙的神色不像作伪', '这条路他问过三回',
  '风里的咸腥渐渐浓了', '马帮铃响时他闪进阴影', '荒村只剩几声狗叫', '城墙上的旗子换了颜色'];
const lines2 = [];
for (let n = 1; n <= 66; n += 1) {
  lines2.push(`${sPlaces[n % sPlaces.length]}${sActs[(n * 5 + 2) % sActs.length]}${sThings[(n * 7 + 3) % sThings.length]}，`
    + `${sSubjects[n % sSubjects.length]}${sMoods[(n * 3 + 1) % sMoods.length]}，一路往${sDirs[n % sDirs.length]}去，`
    + `${sTimes[(n * 11 + 5) % sTimes.length]}，${sTails[(n * 13 + 7) % sTails.length]}。`);
}
const cand2 = `# 第002章 赶路\n\n${lines2.join('\n')}\n`;
const f = path.join(os.tmpdir(), 'cand2.md');
fs.writeFileSync(f, cand2);
console.log('CJK chars:', (cand2.replace(/[^\u4e00-\u9fff]/g, '')).length);
for (const s of ['guyin-check-integrity.js', 'guyin-check-wordcount.js']) {
  const args = s === 'guyin-check-wordcount.js' ? ['--json', '--min=2500', '--max=9000', f] : ['--json', f];
  const r = spawnSync('node', [path.join(process.cwd(), 'skills/guyin-write/scripts', s), ...args], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  const blocking = (out.findings || []).filter((x) => x.severity === 'blocking' || x.handling === 'hard');
  console.log(s, 'exit', r.status, 'blocking:', blocking.map((x) => `${x.type}:${(x.excerpt || x.message || '').slice(0, 50)}`));
}
