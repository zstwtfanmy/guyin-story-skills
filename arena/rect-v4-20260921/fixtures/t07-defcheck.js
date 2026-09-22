const fs = require('fs');
const REPO = 'D:/readbook-wpace/guyin-skills';
const styleTxt = fs.readFileSync(REPO + '/skills/guyin-write/references/默认叙事风格.md', 'utf8');
const route = JSON.parse(styleTxt.match(/```json\s*\n([\s\S]*?)\n```/)[1]);
const VERSIONS = { 'relationship-payoff': 2 };
const asLf = styleTxt.replace(/\r\n/g, '\n');
for (const [label, txt] of [['工作区原样', styleTxt], ['LF 化', asLf]]) {
  const missingDef = route.profiles.filter((p) => {
    const re = new RegExp(`### ${p.id} / v${p.version}\n+([\s\S]*?)(?=\n### |\n## |$)`);
    const m = txt.match(re);
    return !m || m[1].replace(/\s/g, '').length < 60;
  });
  console.log(label, '缺定义:', missingDef.length ? missingDef.map((p) => p.id).join(',') : '无（全部通过）');
}
