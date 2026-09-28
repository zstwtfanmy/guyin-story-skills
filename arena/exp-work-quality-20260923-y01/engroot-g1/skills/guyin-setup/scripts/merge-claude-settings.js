#!/usr/bin/env node
'use strict';

// merge-claude-settings.js — Claude Code settings.json hooks 节确定性合并（guyin-setup 部署件）
//
// 场景：guyin-setup 部署硬护栏 hook 时项目已有 .claude/settings.json（可能带用户自己的
// hooks / permissions / 其他顶层字段）。直接覆盖会毁用户配置；让模型手改 JSON 不可靠——
// 合并走本脚本，确定性 + 幂等。
//
// 用法：node merge-claude-settings.js --template <模板settings.json> --target <项目settings.json>
//
// 规则：
//   1. target 不存在 → 等价于复制模板（全量顶层字段，含 _comment 说明）；
//   2. 管理身份识别：hook entry 的 command 含 "guyin-hook.js" 即视为隐笔管理注册，
//      合并前从 target 整条移除（历史版本的注册写法一并清理）；
//   3. 模板 hooks 节按 event 追加（同 event 同 matcher 的管理 block 只保留模板版）；
//   4. 用户 hooks（command 不含 guyin-hook.js）、matcher 块、全部未知顶层字段原样保留；
//   5. 幂等：重复执行输出字节一致（2 空格缩进稳定序列化）。
//
// 退出码：0 成功；1 参数缺失 / JSON 解析失败 / 读写失败（fail-fast，不静默写半成品）。

const fs = require('fs');
const path = require('path');

const MANAGED_MARK = 'guyin-hook.js';

function fail(msg) {
  process.stderr.write(`merge-claude-settings: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--template') out.template = argv[i + 1];
    else if (argv[i] === '--target') out.target = argv[i + 1];
  }
  if (!out.template || !out.target) {
    fail('用法: node merge-claude-settings.js --template <模板settings.json> --target <项目settings.json>');
  }
  return out;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`无法读取 ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${file} 不是合法 JSON: ${e.message}`);
  }
}

const isManaged = (entry) => Boolean(entry) && typeof entry.command === 'string' && entry.command.includes(MANAGED_MARK);

// 移除 target.hooks 中所有管理注册；清空后的 block / event / hooks 节依次收缩删除。
function stripManaged(hooks) {
  if (!hooks || typeof hooks !== 'object') return {};
  const cleaned = {};
  for (const [event, blocks] of Object.entries(hooks)) {
    if (!Array.isArray(blocks)) continue;
    const keptBlocks = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const entries = Array.isArray(block.hooks) ? block.hooks.filter((h) => !isManaged(h)) : [];
      if (entries.length === 0) continue; // 整块都是管理注册（或空块）→ 移除
      keptBlocks.push({ ...block, hooks: entries });
    }
    if (keptBlocks.length > 0) cleaned[event] = keptBlocks;
  }
  return cleaned;
}

// 把模板 hooks 追加进已清理的 target hooks：同 event 同 matcher 已有用户 block 时，
// 管理条目并入该 block 尾部；否则整块追加。同 command 的管理条目不重复（幂等保障）。
function mergeHooks(targetHooks, templateHooks) {
  const merged = { ...targetHooks };
  for (const [event, blocks] of Object.entries(templateHooks || {})) {
    if (!Array.isArray(blocks)) continue;
    const existing = Array.isArray(merged[event]) ? merged[event] : (merged[event] = []);
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const managed = Array.isArray(block.hooks) ? block.hooks.filter(isManaged) : [];
      if (managed.length === 0) continue; // 模板里只有管理注册，其余不存在的情形不处理
      const sameMatcher = existing.find((b) => b && typeof b === 'object' && b.matcher === block.matcher);
      if (sameMatcher) {
        sameMatcher.hooks = Array.isArray(sameMatcher.hooks) ? sameMatcher.hooks : [];
        for (const entry of managed) {
          if (!sameMatcher.hooks.some((h) => h && typeof h.command === 'string' && h.command === entry.command)) {
            sameMatcher.hooks.push(entry);
          }
        }
      } else {
        existing.push({ ...block, hooks: [...managed] });
      }
    }
  }
  return merged;
}

const { template: templatePath, target: targetPath } = parseArgs(process.argv.slice(2));
const template = readJson(templatePath);

if (!fs.existsSync(targetPath)) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  process.stdout.write(`已创建 ${targetPath}（自模板全量复制）\n`);
  process.exit(0);
}

const target = readJson(targetPath);
const cleaned = stripManaged(target.hooks);
const mergedHooks = mergeHooks(cleaned, template.hooks);
const merged = { ...target };
if (Object.keys(mergedHooks).length > 0) merged.hooks = mergedHooks;
else delete merged.hooks;

fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
process.stdout.write(`已合并 hooks 注册到 ${targetPath}（用户配置保留，管理注册刷新）\n`);
