import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('workbench.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
test('基线：HTML 入口、无外部资源与 JavaScript 语法', () => {
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /width=device-width/);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/);
});
test('基线：六个虚构客户编号唯一，两个客户类型存在', () => {
  const ids = [...scripts[0].matchAll(/id:'(demo-\d{3})'/g)].map(m=>m[1]);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.match(scripts[0], /企业客户/);
  assert.match(scripts[0], /个人客户/);
});
test('基线：客户数据、搜索筛选、详情路由与无网络请求约束保留', () => {
  assert.match(scripts[0], /const CUSTOMERS=Object\.freeze/);
  assert.match(scripts[0], /document\.getElementById\('search'\)/);
  assert.match(scripts[0], /document\.getElementById\('segment'\)/);
  assert.match(scripts[0], /function renderList\(\)/);
  assert.match(scripts[0], /function renderDetail\(\)/);
  assert.match(scripts[0], /customer\\\/\(demo-/);
  assert.doesNotMatch(scripts[0], /fetch\(|XMLHttpRequest/);
});
test('渲染：动态文本使用 textContent，避免注入 HTML', () => {
  assert.doesNotMatch(scripts[0], /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  assert.match(scripts[0], /textContent=text/);
});
test('构建：静态发布目录与版本元信息一致', () => {
  const version = JSON.parse(readFileSync(new URL('public/version.json', import.meta.url), 'utf8'));
  const built = readFileSync(new URL('public/index.html', import.meta.url), 'utf8');
  assert.equal(version.demo, true);
  assert.equal(version.storage, 'browser-local-only');
  assert.doesNotMatch(built, /__BUILD_COMMIT__/);
  assert.match(version.commit, /^(?:[a-f0-9]{40}|uncommitted)$/);
});
test('发布保护：禁用 Git 推送自动部署', () => {
  const config = JSON.parse(readFileSync(new URL('vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.git.deploymentEnabled, false);
  assert.equal(config.outputDirectory, 'public');
});
