import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('workbench.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
const script = scripts[0];
const KEY = 'manager-workbench.followups.v1';
const TODAY = '2026-11-01';

class FakeText {
  constructor(text) { this.textContent = String(text); this.parentNode = null; }
}

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(n => this.values.add(n)); }
  remove(...names) { names.forEach(n => this.values.delete(n)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.classList = new ClassList();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.name = '';
    this.htmlFor = '';
    this.placeholder = '';
    this.noValidate = false;
    this._text = '';
    this._listeners = new Map();
    let id = '';
    Object.defineProperty(this, 'id', {
      get: () => id,
      set: value => {
        if (id) this.ownerDocument.elements.delete(id);
        id = String(value);
        if (id) this.ownerDocument.elements.set(id, this);
      }
    });
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this._detachChildren(); }
  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'string' ? new FakeText(node) : node;
      this.children.push(child);
      child.parentNode = this;
    }
  }
  replaceChildren(...nodes) {
    this._detachChildren();
    this._text = '';
    this.append(...nodes);
  }
  _detachChildren() {
    for (const child of this.children) this.ownerDocument.detach(child);
    this.children = [];
  }
  reset() {
    const walk = el => {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') el.value = '';
      for (const child of el.children) walk(child);
    };
    walk(this);
  }
  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }
  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
      ...extra
    };
    for (const listener of this._listeners.get(type) || []) listener.call(this, event);
    return event;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = value;
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  focus() { this.ownerDocument.activeElement = this; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
    this.body = this.createElement('body');
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
  createTextNode(text) { return new FakeText(text); }
  getElementById(id) { return this.elements.get(id) || null; }
  addEventListener() {}
  detach(node) {
    if (!node) return;
    if (node.id) this.elements.delete(node.id);
    node.parentNode = null;
    if (node.children) for (const child of node.children) this.detach(child);
  }
}

class FakeStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failGet = null;
    this.failSet = null;
    this.failRemove = null;
  }
  getItem(key) {
    if (this.failGet) throw this.failGet;
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.failSet) throw this.failSet;
    this.map.set(key, String(value));
  }
  removeItem(key) {
    if (this.failRemove) throw this.failRemove;
    this.map.delete(key);
  }
}

function fakeDate(isoDate) {
  const RealDate = Date;
  const fixed = new RealDate(`${isoDate}T12:00:00`).getTime();
  return class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}

function makeDocument() {
  const document = new FakeDocument();
  const add = (id, tag = 'div', props = {}, parent = document.body) => {
    const el = document.createElement(tag);
    el.id = id;
    Object.assign(el, props);
    parent.append(el);
    return el;
  };
  add('customer-list', 'ul');
  add('search', 'input', { type: 'search', value: '' });
  add('segment', 'select', { value: 'all' });
  add('count', 'span');
  add('empty', 'div', { hidden: false });
  add('detail', 'div');
  add('detail-panel', 'section');
  add('directory', 'section');
  add('layout', 'div', { dataset: { detail: 'false' } });
  add('reset', 'button');
  const workbench = add('workbench', 'section');
  add('today-badge', 'span', {}, workbench);
  add('today-date', 'span', {}, workbench);
  add('storage-banner', 'div', { hidden: true }, workbench);
  add('overdue-section', 'section', {}, workbench);
  add('overdue-title', 'h3', {}, workbench);
  add('overdue-count', 'span', {}, workbench);
  add('overdue-list', 'ul', {}, workbench);
  add('today-section', 'section', {}, workbench);
  add('today-title', 'h3', {}, workbench);
  add('today-count', 'span', {}, workbench);
  add('today-list', 'ul', {}, workbench);
  return document;
}

let idSeq = 0;
function createApp({ storage = new FakeStorage(), today = TODAY } = {}) {
  const document = makeDocument();
  const events = new Map();
  const location = {
    _hash: '#customers',
    get hash() { return this._hash; },
    set hash(value) {
      const next = String(value).startsWith('#') ? String(value) : `#${value}`;
      this._hash = next;
      for (const listener of events.get('hashchange') || []) listener({ type: 'hashchange' });
    }
  };
  const window = {
    localStorage: storage,
    addEventListener(type, listener) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(listener);
    }
  };
  const sandbox = {
    document,
    window,
    location,
    console,
    Date: fakeDate(today),
    crypto: { randomUUID: () => `test-id-${++idSeq}` }
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'workbench.html' });
  return { document, window, location, storage, sandbox };
}

function run(app, expression) { return vm.runInContext(expression, app.sandbox); }
function byId(app, id) { return app.document.getElementById(id); }
function records(app) { return run(app, 'records'); }
function storageState(app) { return run(app, 'storageState'); }

function findAll(root, predicate) {
  const found = [];
  const walk = node => {
    if (!(node instanceof FakeElement)) return;
    if (predicate(node)) found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

function buttonsIn(root, action, recordId) {
  return findAll(root, el => el.tagName === 'BUTTON' && el.dataset.action === action && (recordId === undefined || el.dataset.recordId === recordId));
}

function click(el) { assert.ok(el, 'expected element to click'); el.dispatch('click'); }

function openCustomer(app, id) { app.location.hash = `customer/${id}`; }

function addFollowup(app, { customerId, date, text }) {
  if (customerId) openCustomer(app, customerId);
  byId(app, 'followup-date').value = date;
  byId(app, 'followup-text').value = text;
  byId(app, 'followup-form').dispatch('submit');
}

function storedEnvelope(app) { return JSON.parse(app.storage.map.get(KEY)); }

test('静态契约：单脚本、无外部资源、无危险 HTML 路径、含存储键与文字徽标', () => {
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest/);
  assert.match(script, /manager-workbench\.followups\.v1/);
  assert.match(html, /已逾期/);
  assert.match(html, /今日待跟进/);
  assert.match(html, /已完成/);
  assert.match(html, /同一浏览器同一 origin/);
  assert.match(html, /换设备、浏览器或访问地址不共享/);
  assert.match(html, /清除浏览器数据后会丢失/);
});

test('日期与输入校验：本地日历日、真实日期、空白事项', () => {
  const app = createApp();
  assert.equal(run(app, "todayISO(new Date(2026,10,1))"), '2026-11-01');
  assert.equal(run(app, "isValidDate('2028-02-29')"), true);
  assert.equal(run(app, "isValidDate('2026-02-30')"), false);
  assert.equal(run(app, "isValidDate('2026-13-01')"), false);
  assert.equal(run(app, "isValidDate('2026-1-1')"), false);
  assert.equal(run(app, "isValidDate('')"), false);
  assert.equal(run(app, "classifyDate('2026-10-31','2026-11-01')"), 'overdue');
  assert.equal(run(app, "classifyDate('2026-11-01','2026-11-01')"), 'today');
  assert.equal(run(app, "classifyDate('2026-11-02','2026-11-01')"), 'future');
  assert.equal(JSON.stringify(run(app, "validateInput('','  ')")), JSON.stringify(['请选择跟进日期。', '请输入跟进事项。']));
  assert.equal(JSON.stringify(run(app, "validateInput('2026-02-30','事项')")), JSON.stringify(['请输入合法日期（YYYY-MM-DD）。']));
  assert.equal(JSON.stringify(run(app, "validateInput('2026-11-01','事项')")), '[]');
});

test('排序：日期升序，同日期按创建时间与 id 稳定排序', () => {
  const app = createApp();
  const ordered = run(app, `[
    {id:'b',date:'2026-10-30',createdAt:20},
    {id:'c',date:'2026-10-29',createdAt:5},
    {id:'a',date:'2026-10-30',createdAt:10}
  ].sort(compareRecords).map(r=>r.id)`);
  assert.equal(JSON.stringify(ordered), JSON.stringify(['c', 'a', 'b']));
});

test('AC-01/AC-02/AC-05：新增归属当前客户、进入今日、刷新重读同一 origin', () => {
  const app = createApp();
  addFollowup(app, { date: TODAY, text: '确认门店收款流程时间' });
  const saved = records(app);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].customerId, 'demo-001');
  assert.equal(saved[0].status, 'open');
  assert.equal(saved[0].date, TODAY);
  assert.equal(saved[0].text, '确认门店收款流程时间');
  assert.equal(storedEnvelope(app).version, 1);
  assert.match(byId(app, 'today-list').textContent, /确认门店收款流程时间/);
  assert.match(byId(app, 'today-list').textContent, /演示客户甲/);
  assert.match(byId(app, 'today-list').textContent, new RegExp(TODAY));
  assert.match(byId(app, 'open-list').textContent, /确认门店收款流程时间/);

  const reopened = createApp({ storage: new FakeStorage(Object.fromEntries(app.storage.map)) });
  assert.match(byId(reopened, 'today-list').textContent, /确认门店收款流程时间/);
  assert.match(byId(reopened, 'open-list').textContent, /确认门店收款流程时间/);

  const otherOrigin = createApp();
  assert.equal(records(otherOrigin).length, 0);
  assert.doesNotMatch(byId(otherOrigin, 'today-list').textContent, /确认门店收款流程时间/);
});

test('AC-03/AC-08：逾期在上且有文字徽标，未来事项不进入工作台', () => {
  const app = createApp();
  addFollowup(app, { date: TODAY, text: '今天事项' });
  addFollowup(app, { date: '2026-10-30', text: '前天逾期事项' });
  addFollowup(app, { date: '2026-11-05', text: '未来事项' });

  const overdue = byId(app, 'overdue-list').textContent;
  const today = byId(app, 'today-list').textContent;
  assert.match(overdue, /前天逾期事项/);
  assert.match(overdue, /已逾期/);
  assert.match(overdue, /逾期 2 天/);
  assert.match(today, /今天事项/);
  assert.doesNotMatch(today, /前天逾期事项/);
  assert.doesNotMatch(overdue, /今天事项/);
  assert.doesNotMatch(byId(app, 'overdue-list').textContent, /未来事项/);
  assert.doesNotMatch(byId(app, 'today-list').textContent, /未来事项/);
  assert.match(byId(app, 'open-list').textContent, /未来事项/);

  const buckets = findAll(byId(app, 'workbench'), el => el.id === 'overdue-section' || el.id === 'today-section');
  assert.equal(JSON.stringify(buckets.map(el => el.id)), JSON.stringify(['overdue-section', 'today-section']));
});

test('AC-06：空白/缺失/非法日期不保存并提示；HTML 按纯文本显示', () => {
  const app = createApp();
  addFollowup(app, { date: '', text: '缺失日期' });
  assert.equal(records(app).length, 0);
  assert.match(byId(app, 'form-feedback').textContent, /请选择跟进日期/);
  assert.doesNotMatch(byId(app, 'form-feedback').textContent, /已保存/);

  addFollowup(app, { date: TODAY, text: '   ' });
  assert.equal(records(app).length, 0);
  assert.match(byId(app, 'form-feedback').textContent, /请输入跟进事项/);

  addFollowup(app, { date: '2026-02-30', text: '非法日期' });
  assert.equal(records(app).length, 0);
  assert.match(byId(app, 'form-feedback').textContent, /请输入合法日期/);

  const injected = '<img src=x onerror=alert(1)><b>不是元素</b>';
  addFollowup(app, { date: TODAY, text: injected });
  assert.equal(records(app).length, 1);
  assert.equal(records(app)[0].text, injected);
  assert.match(byId(app, 'today-list').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(findAll(byId(app, 'detail'), el => el.tagName === 'IMG' || el.tagName === 'B').length, 0);
  assert.equal(findAll(app.document.body, el => el.tagName === 'IMG').length, 0);
});

test('AC-07：客户详情与工作台归属隔离', () => {
  const app = createApp();
  addFollowup(app, { customerId: 'demo-001', date: TODAY, text: '甲的今日事项' });
  addFollowup(app, { customerId: 'demo-002', date: TODAY, text: '乙的今日事项' });

  openCustomer(app, 'demo-001');
  assert.match(byId(app, 'open-list').textContent, /甲的今日事项/);
  assert.doesNotMatch(byId(app, 'open-list').textContent, /乙的今日事项/);

  openCustomer(app, 'demo-002');
  assert.match(byId(app, 'open-list').textContent, /乙的今日事项/);
  assert.doesNotMatch(byId(app, 'open-list').textContent, /甲的今日事项/);

  assert.match(byId(app, 'today-list').textContent, /演示客户甲/);
  assert.match(byId(app, 'today-list').textContent, /演示客户乙/);
  assert.equal(records(app).filter(r => r.customerId === 'demo-001').length, 1);
  assert.equal(records(app).filter(r => r.customerId === 'demo-002').length, 1);
});

test('AC-04/AC-11：完成移出未完成区、详情保留；撤销后重新进入', () => {
  const app = createApp();
  addFollowup(app, { date: TODAY, text: '待完成事项' });
  const detail = byId(app, 'detail');
  const recordId = records(app)[0].id;
  click(buttonsIn(detail, 'complete', recordId)[0]);

  assert.equal(records(app)[0].status, 'done');
  assert.doesNotMatch(byId(app, 'today-list').textContent, /待完成事项/);
  assert.match(byId(app, 'done-list').textContent, /待完成事项/);
  assert.match(byId(app, 'done-list').textContent, /已完成/);
  assert.doesNotMatch(byId(app, 'open-list').textContent, /待完成事项/);

  click(buttonsIn(byId(app, 'detail'), 'undo', recordId)[0]);
  assert.equal(records(app)[0].status, 'open');
  assert.match(byId(app, 'today-list').textContent, /待完成事项/);
  assert.match(byId(app, 'open-list').textContent, /待完成事项/);
});

test('AC-12：编辑未完成记录按新日期重新分区，已完成记录保持完成', () => {
  const app = createApp();
  addFollowup(app, { date: TODAY, text: '待编辑事项' });
  const id = records(app)[0].id;

  click(buttonsIn(byId(app, 'detail'), 'edit', id)[0]);
  const editForm = findAll(byId(app, 'detail'), el => el.tagName === 'FORM' && el.dataset.recordId === id)[0];
  assert.ok(editForm, 'edit form should exist');
  byId(app, `edit-date-${id}`).value = '2026-10-25';
  byId(app, `edit-text-${id}`).value = '已改到过去';
  editForm.dispatch('submit');

  assert.equal(records(app)[0].date, '2026-10-25');
  assert.equal(records(app)[0].text, '已改到过去');
  assert.equal(records(app)[0].customerId, 'demo-001');
  assert.equal(records(app)[0].status, 'open');
  assert.match(byId(app, 'overdue-list').textContent, /已改到过去/);
  assert.doesNotMatch(byId(app, 'today-list').textContent, /已改到过去/);

  click(buttonsIn(byId(app, 'detail'), 'complete', id)[0]);
  click(buttonsIn(byId(app, 'detail'), 'edit', id)[0]);
  const doneForm = findAll(byId(app, 'detail'), el => el.tagName === 'FORM' && el.dataset.recordId === id)[0];
  byId(app, `edit-date-${id}`).value = TODAY;
  byId(app, `edit-text-${id}`).value = '完成后改文本';
  doneForm.dispatch('submit');
  assert.equal(records(app)[0].status, 'done');
  assert.equal(records(app)[0].text, '完成后改文本');
  assert.match(byId(app, 'done-list').textContent, /完成后改文本/);
  assert.doesNotMatch(byId(app, 'today-list').textContent, /完成后改文本/);

  click(buttonsIn(byId(app, 'detail'), 'edit', id)[0]);
  const invalidForm = findAll(byId(app, 'detail'), el => el.tagName === 'FORM' && el.dataset.recordId === id)[0];
  byId(app, `edit-date-${id}`).value = '';
  byId(app, `edit-text-${id}`).value = '不应保存';
  invalidForm.dispatch('submit');
  assert.equal(records(app)[0].text, '完成后改文本');
  assert.match(byId(app, 'detail').textContent, /请选择跟进日期/);
});

test('AC-13：删除需确认，取消保留，确认后两处移除且不影响其他记录', () => {
  const app = createApp();
  addFollowup(app, { date: TODAY, text: '待删除事项' });
  addFollowup(app, { date: TODAY, text: '保留事项' });
  const deleteId = records(app).find(r => r.text === '待删除事项').id;

  click(buttonsIn(byId(app, 'detail'), 'delete', deleteId)[0]);
  assert.match(byId(app, 'detail').textContent, /确认删除该记录？此操作不可撤销。/);
  click(buttonsIn(byId(app, 'detail'), 'cancel-delete', deleteId)[0]);
  assert.equal(records(app).length, 2);
  assert.match(byId(app, 'detail').textContent, /待删除事项/);

  click(buttonsIn(byId(app, 'detail'), 'delete', deleteId)[0]);
  click(buttonsIn(byId(app, 'detail'), 'confirm-delete', deleteId)[0]);
  assert.equal(records(app).length, 1);
  assert.equal(records(app)[0].text, '保留事项');
  assert.doesNotMatch(byId(app, 'detail').textContent, /待删除事项/);
  assert.doesNotMatch(byId(app, 'today-list').textContent, /待删除事项/);
  assert.match(byId(app, 'today-list').textContent, /保留事项/);
  assert.equal(storedEnvelope(app).records.length, 1);
});

test('AC-09：存储写入失败不假成功，配额与禁用分别提示', () => {
  const app = createApp();
  app.storage.failSet = new Error('storage disabled');
  addFollowup(app, { date: TODAY, text: '不应保存' });
  assert.equal(records(app).length, 0);
  assert.equal(app.storage.map.has(KEY), false);
  assert.match(byId(app, 'form-feedback').textContent, /未保存/);
  assert.doesNotMatch(byId(app, 'form-feedback').textContent, /已保存/);
  assert.equal(byId(app, 'storage-banner').hidden, false);
  assert.match(byId(app, 'storage-banner').textContent, /未保存/);
  assert.equal(byId(app, 'followup-text').value, '不应保存');

  const quota = createApp();
  const quotaError = new Error('quota');
  quotaError.name = 'QuotaExceededError';
  quota.storage.failSet = quotaError;
  addFollowup(quota, { date: TODAY, text: '配额失败' });
  assert.equal(records(quota).length, 0);
  assert.match(byId(quota, 'form-feedback').textContent, /空间不足/);

  const disabled = createApp();
  disabled.storage.failGet = new Error('denied');
  const rebuilt = createApp({ storage: disabled.storage });
  assert.equal(storageState(rebuilt), 'unavailable');
  assert.equal(records(rebuilt).length, 0);
  assert.match(byId(rebuilt, 'storage-banner').textContent, /无法使用浏览器本地存储/);
  assert.equal(byId(rebuilt, 'followup-date').disabled, true);
  assert.equal(run(rebuilt, "addRecord('demo-001','2026-11-01','不应保存')").ok, false);
  assert.equal(records(rebuilt).length, 0);
});

test('AC-09：损坏与未知版本不被静默覆盖，需显式确认清除', () => {
  const corruptStorage = new FakeStorage({ [KEY]: '{broken' });
  const app = createApp({ storage: corruptStorage });
  assert.equal(storageState(app), 'corrupt');
  assert.equal(corruptStorage.map.get(KEY), '{broken');
  assert.match(byId(app, 'storage-banner').textContent, /损坏/);
  assert.equal(byId(app, 'followup-date').disabled, true);
  assert.equal(run(app, "addRecord('demo-001','2026-11-01','不应保存')").ok, false);
  assert.equal(corruptStorage.map.get(KEY), '{broken');

  click(buttonsIn(byId(app, 'workbench'), 'clear-storage')[0]);
  assert.match(byId(app, 'storage-banner').textContent, /确认清除/);
  click(buttonsIn(byId(app, 'workbench'), 'confirm-clear-storage')[0]);
  assert.equal(corruptStorage.map.has(KEY), false);
  assert.equal(storageState(app), 'ok');
  assert.equal(records(app).length, 0);

  const unknownCustomer = createApp({
    storage: new FakeStorage({
      [KEY]: JSON.stringify({
        version: 1,
        records: [{ id: 'x', customerId: 'demo-999', date: TODAY, text: 'x', status: 'open', createdAt: 1 }]
      })
    })
  });
  assert.equal(storageState(unknownCustomer), 'corrupt');

  const futureVersion = new FakeStorage({
    [KEY]: JSON.stringify({ version: 2, records: [] })
  });
  const versioned = createApp({ storage: futureVersion });
  assert.equal(storageState(versioned), 'version');
  assert.match(byId(versioned, 'storage-banner').textContent, /版本/);
  assert.equal(run(versioned, "addRecord('demo-001','2026-11-01','不应保存')").ok, false);
  assert.match(futureVersion.map.get(KEY), /"version":2/);

  const duplicateIds = createApp({
    storage: new FakeStorage({
      [KEY]: JSON.stringify({
        version: 1,
        records: [
          { id: 'dup', customerId: 'demo-001', date: TODAY, text: 'a', status: 'open', createdAt: 1 },
          { id: 'dup', customerId: 'demo-002', date: TODAY, text: 'b', status: 'open', createdAt: 2 }
        ]
      })
    })
  });
  assert.equal(storageState(duplicateIds), 'corrupt');
});

test('AC-10：保留搜索/筛选与详情路由，工作台不受筛选影响', () => {
  const app = createApp();
  addFollowup(app, { customerId: 'demo-001', date: TODAY, text: '甲的提醒' });
  addFollowup(app, { customerId: 'demo-002', date: TODAY, text: '乙的提醒' });

  const beforeToday = byId(app, 'today-list').textContent;
  byId(app, 'search').value = '演示客户乙';
  byId(app, 'search').dispatch('input');
  assert.match(byId(app, 'customer-list').textContent, /演示客户乙/);
  assert.doesNotMatch(byId(app, 'customer-list').textContent, /演示客户甲/);
  assert.equal(byId(app, 'today-list').textContent, beforeToday);

  byId(app, 'segment').value = '个人客户';
  byId(app, 'segment').dispatch('change');
  assert.match(byId(app, 'customer-list').textContent, /演示客户乙/);
  assert.doesNotMatch(byId(app, 'customer-list').textContent, /演示客户戊/);
  assert.equal(byId(app, 'today-list').textContent, beforeToday);

  click(byId(app, 'reset'));
  assert.equal(byId(app, 'search').value, '');
  assert.equal(byId(app, 'segment').value, 'all');
  assert.match(byId(app, 'customer-list').textContent, /演示客户甲/);

  openCustomer(app, 'demo-002');
  assert.equal(byId(app, 'layout').dataset.detail, 'true');
  assert.match(byId(app, 'detail').textContent, /演示客户乙/);
  assert.doesNotMatch(byId(app, 'detail').textContent, /甲的提醒/);
  app.location.hash = 'customers';
  assert.equal(byId(app, 'layout').dataset.detail, 'false');
});
