const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture() {
  const source = fs.readFileSync(require.resolve('../firefox/background.js'), 'utf8');
  const nodes = [];
  const document = { title: 'Fixture', body: { innerText: 'Inbox' }, querySelectorAll: selector => nodes.filter(n => n.native || selector.includes(`[role="${n.attrs.role}"]`)), elementFromPoint: x => nodes.find(n => n.x === x), querySelector: () => null };
  const context = vm.createContext({ document, innerWidth: 1000, innerHeight: 800, location: { href: 'https://fixture.test' } });
  vm.runInContext(source.slice(source.indexOf('function pageAction('), source.indexOf('async function command(')), context);
  const action = (method, args = {}) => context.pageAction({ method, args });
  const add = (label, role, native = false) => {
    const x = 10 + nodes.length * 30;
    const node = { x, scrollIntoView() {}, getBoundingClientRect: () => ({left:x-5,right:x+5,top:0,bottom:10}), contains: () => false, native, attrs: { role, 'aria-label': label, 'aria-checked': 'false', 'aria-expanded': 'false' }, tagName: 'DIV', isConnected: true, innerText: '', getClientRects: () => [1], getAttribute(name) { return this.attrs[name] ?? null; }, click() { this.clicked = true; } };
    nodes.push(node); return node;
  };
  return { nodes, action, add };
}
test('snapshots expose custom checkboxes and menus and retain identity after insertion', () => {
  const f = fixture(); const checkbox = f.add('Select', 'checkbox'); const menu = f.add('Unread', 'menuitem');
  const first = f.action('browser_snapshot');
  assert.equal(first.controls.length, 2); assert.equal(first.controls[0].checked, 'false');
  const inserted = f.add('Other', 'button', true); f.nodes.unshift(f.nodes.pop());
  const second = f.action('browser_snapshot');
  assert.equal(second.controls.find(c => c.label === 'Select').ref, first.controls[0].ref);
  assert.equal(f.action('browser_click', { ref: first.controls[0].ref }).x, checkbox.x); assert.equal(inserted.clicked, undefined); assert.equal(menu.clicked, undefined);
});
test('removed references cannot silently target a replacement control', () => {
  const f = fixture(); const old = f.add('Old', 'button', true);
  const ref = f.action('browser_snapshot').controls[0].ref;
  old.isConnected = false; f.nodes.length = 0; const replacement = f.add('New', 'button', true);
  f.action('browser_snapshot');
  assert.throws(() => f.action('browser_click', { ref }), /页面元素已变化/);
  assert.equal(replacement.clicked, undefined);
});
test('unchanged repeated clicks are bounded and new page evidence permits another attempt', () => {
  const f = fixture(); const node = f.add('Menu', 'button', true);
  const ref = f.action('browser_snapshot').controls[0].ref;
  f.action('browser_click', { ref }); f.action('browser_click', { ref });
  assert.throws(() => f.action('browser_click', { ref }), /已阻止重复点击/);
  node.attrs['aria-expanded'] = 'true';
  assert.doesNotThrow(() => f.action('browser_click', { ref }));
});
