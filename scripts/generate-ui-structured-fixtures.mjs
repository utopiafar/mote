// Completely generated UI evidence: no real device, account or captured personal data.
import {readFileSync, writeFileSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const rules = JSON.parse(readFileSync(new URL('adapters/ui/examples/generated-article-product.json', root), 'utf8'));
const builtinRules = JSON.parse(readFileSync(new URL('adapters/ui/builtin.json', root), 'utf8')).filter(rule => rule.formatVersion === 2);
const at = '2026-10-10T08:00:00Z';
const article = rules[0], product = rules[1];
const node = (id, resourceId, text = '', parentId) => ({id, resourceId, text, role: 'android.widget.TextView', bounds: {x: 0, y: 0, width: 100, height: 20}, ...(parentId ? {parentId} : {})});
const snapshot = (rule, nodes) => ({appId: rule.appId, appVersion: rule.appVersion, activity: rule.activity, observedAt: at, nodes, truncated: false});
const page = (rule, object, truncated = false) => ({version: 2, scope: 'visible_window', adapterId: rule.id, adapterVersion: rule.version, appVersion: rule.appVersion, activity: rule.activity, status: truncated ? 'partial' : 'ok', truncated, observations: {firstAt: at, lastAt: at, count: 1}, objects: [object]});
const articleNodes = [node('a', article.region.resourceId), node('t', article.fields.title.select.resourceId, 'Generated article title', 'a'), node('author', article.fields.author.select.resourceId, 'Generated author', 'a'), node('u', article.fields.url.select.resourceId, 'https://example.invalid/articles/one', 'a'), node('p1', article.fields.body.select.resourceId, 'Generated paragraph one.', 'a'), node('p2', article.fields.body.select.resourceId, 'Generated paragraph two.', 'a')];
const articleObject = {kind: 'article', title: 'Generated article title', author: 'Generated author', url: 'https://example.invalid/articles/one', body: [{text: 'Generated paragraph one.'}, {text: 'Generated paragraph two.'}], identity: {type: 'url', value: 'https://example.invalid/articles/one'}};
const productNodes = [node('catalog', product.region.resourceId), ...['one', 'two'].flatMap((id) => [node(`card-${id}`, product.repeat.resourceId, '', 'catalog'), node(`title-${id}`, product.fields.title.select.resourceId, 'Generated matching product title', `card-${id}`), node(`url-${id}`, product.fields.url.select.resourceId, `https://example.invalid/products/${id}`, `card-${id}`), node(`id-${id}`, product.fields.itemId.select.resourceId, id, `card-${id}`)])];
const productObject = id => ({kind: 'product', title: 'Generated matching product title', url: `https://example.invalid/products/${id}`, itemId: id, body: [], identity: {type: 'source_id', value: id}});
const cases = [];
const add = (name, rule, nodes, mutate = () => {}, expected = []) => {const s = snapshot(rule, structuredClone(nodes)); mutate(s); cases.push({name, platform: 'android', rules: [rule], snapshot: s, expected});};
add('article-visible-window', article, articleNodes, undefined, [page(article, articleObject)]);
add('article-wrong-version', article, articleNodes, s => {s.appVersion = '2.0.0';});
add('article-wrong-page', article, articleNodes, s => {s.activity = 'Generated.OtherPage';});
add('article-wrong-app', article, articleNodes, s => {s.appId = 'dev.mote.generated.other';});
add('article-empty-title', article, articleNodes, s => {s.nodes.find(n => n.id === 't').text = ' ';});
add('article-no-body', article, articleNodes, s => {s.nodes = s.nodes.filter(n => !n.id.startsWith('p'));});
add('article-truncated', article, articleNodes, s => {s.truncated = true;}, [page(article, articleObject, true)]);
add('article-repeat-paragraphs-preserved', article, articleNodes, s => {s.nodes.find(n => n.id === 'p2').text = s.nodes.find(n => n.id === 'p1').text;}, [page(article, {...articleObject, body: [{text: 'Generated paragraph one.'}, {text: 'Generated paragraph one.'}]})]);
add('article-ambiguous-title', article, articleNodes, s => {s.nodes.push(node('other-title', article.fields.title.select.resourceId, 'Other generated title', 'a'));});
add('article-navigation-outside-region', article, articleNodes, s => {s.nodes.push(node('nav', article.fields.title.select.resourceId, 'Generated navigation'));}, [page(article, articleObject)]);
add('article-no-reliable-identity', article, articleNodes, s => {s.nodes = s.nodes.filter(n => n.id !== 'u');}, [page(article, {kind: 'article', title: articleObject.title, author: articleObject.author, body: articleObject.body})]);
add('article-invalid-link-not-guessed', article, articleNodes, s => {s.nodes.find(n => n.id === 'u').text = 'Share article';}, [page(article, {kind: 'article', title: articleObject.title, author: articleObject.author, body: articleObject.body})]);
add('article-long-visible-paragraph', article, articleNodes, s => {s.nodes.find(n => n.id === 'p1').text = 'Generated long visible paragraph. '.repeat(90);}, [page(article, {...articleObject, body: [{text: 'Generated long visible paragraph. '.repeat(90)}, articleObject.body[1]]})]);
add('article-bounded-body-blocks', article, articleNodes, s => {s.nodes = s.nodes.filter(n => !n.id.startsWith('p')); for (let i = 0; i < 65; i++) s.nodes.push(node(`generated-paragraph-${i}`, article.fields.body.select.resourceId, `Generated bounded paragraph ${i}.`, 'a'));}, [page(article, {...articleObject, body: Array.from({length: 64}, (_, i) => ({text: `Generated bounded paragraph ${i}.`}))}, true)]);
add('article-optional-author-ambiguous', article, articleNodes, s => {s.nodes.push(node('second-author', article.fields.author.select.resourceId, 'Generated other author', 'a'));}, [page(article, {kind: 'article', title: articleObject.title, url: articleObject.url, body: articleObject.body, identity: articleObject.identity})]);
add('article-scrolled-window', article, articleNodes, s => {s.observedAt = '2026-10-10T08:00:30Z'; s.nodes.find(n => n.id === 'p1').text = 'Generated paragraph two.'; s.nodes.find(n => n.id === 'p2').text = 'Generated paragraph three.';}, [{...page(article, {...articleObject, body: [{text: 'Generated paragraph two.'}, {text: 'Generated paragraph three.'}]}), observations: {firstAt: '2026-10-10T08:00:30Z', lastAt: '2026-10-10T08:00:30Z', count: 1}}]);
add('product-distinct-cards-same-title', product, productNodes, undefined, [page(product, productObject('one')), page(product, productObject('two'))]);
add('product-wrong-version', product, productNodes, s => {s.appVersion = '2.0.0';});
add('product-wrong-page', product, productNodes, s => {s.activity = 'Generated.OtherPage';});
add('product-empty-title', product, productNodes, s => {for (const n of s.nodes) if (n.id.startsWith('title')) n.text = '';});
add('product-missing-card-structure', product, productNodes, s => {for (const n of s.nodes) if (n.id.startsWith('card')) n.resourceId = 'generated-other';});
add('product-no-reliable-identity', product, productNodes, s => {s.nodes = s.nodes.filter(n => !n.id.startsWith('url') && !n.id.startsWith('id'));}, ['one', 'two'].map(() => page(product, {kind: 'product', title: 'Generated matching product title', body: []})));
add('product-truncated-visible-cards', product, productNodes, s => {s.truncated = true;}, [page(product, productObject('one'), true), page(product, productObject('two'), true)]);
// These selectors mirror historical structural evidence only. Text is newly generated.
// Replay proves the mapping contract, not the current behavior of either real App.
// Pin independently recorded App metadata so editing a rule cannot regenerate its own matching page.
const historicalMetadata = {
  'wechat-article-android-8.0.78': {appId: 'com.tencent.mm', appVersion: '8.0.78', activity: 'com.tencent.mm.plugin.brandservice.ui.timeline.preload.ui.TmplWebViewMMUI'},
  'taobao-products-android-10.66.22': {appId: 'com.taobao.taobao', appVersion: '10.66.22', activity: 'com.taobao.tao.welcome.Welcome'},
};
for (const rule of builtinRules) {
  const historical = historicalMetadata[rule.id];
  if (!historical) throw Error(`Missing independent historical App metadata for ${rule.id}`);
  let nodes, object;
  if (rule.kind === 'article') {
    nodes = [node('web', '', ''), node('article', 'js_article', '', 'web'), node('title', 'activity-name', 'Generated historical article title', 'article'), {...node('author', 'js_name', 'Generated historical author', 'article'), role: 'android.widget.Button'}, node('content', 'js_content', '', 'article'), node('paragraph', '', 'Generated historical article paragraph.', 'content'), node('outside', '', 'Generated unrelated page footer', 'web')];
    object = {kind: 'article', title: 'Generated historical article title', author: 'Generated historical author', body: [{text: 'Generated historical article paragraph.'}]};
  } else {
    nodes = [node('wrapper', rule.region.resourceId), {...node('list', '', '', 'wrapper'), role: rule.repeatParent.role, childIndex: 0}, {...node('card', '', '', 'list'), role: rule.repeat.role, childIndex: 0}, {...node('card0', '', '', 'card'), role: 'android.widget.LinearLayout', childIndex: 0}, {...node('card00', '', '', 'card0'), role: 'android.widget.LinearLayout', childIndex: 0}, {...node('price', '', 'Generated price label', 'card00'), childIndex: 0}, {...node('title-parent', '', '', 'card00'), role: 'android.widget.LinearLayout', childIndex: 1}, {...node('title', '', 'Generated historical product title', 'title-parent'), childIndex: 0}];
    object = {kind: 'product', title: 'Generated historical product title', body: []};
  }
  const named = (suffix, mutate, expected) => add(`builtin-${rule.id}-${suffix}`, rule, nodes, s => {Object.assign(s, historical); mutate?.(s);}, expected);
  named('visible', undefined, [page(rule, object)]);
  named('wrong-version', s => {s.appVersion = 'generated-other-version';});
  named('wrong-app', s => {s.appId = 'dev.mote.generated.other';});
  named('wrong-page', s => {s.activity = 'Generated.OtherPage';});
  named('empty-content', s => {for (const n of s.nodes) n.text = '';});
  named('missing-structure', s => {s.nodes = [];});
  named('truncated', s => {s.truncated = true;}, [page(rule, object, true)]);
  if (rule.kind === 'article') {
    named('body-outside-container', s => {s.nodes.find(n => n.id === 'paragraph').parentId = 'article';});
    named('unrelated-title-outside-region', s => {s.nodes.push(node('noise', 'activity-name', 'Generated navigation title'));}, [page(rule, object)]);
    // The historical 20260922_110438_wechat-article3 tree has body TextViews at depths 25–27.
    // Recreate only that structural depth with generated text, independently of the reader's limit.
    const deepNodes = nodes.filter(n => n.id !== 'paragraph');
    let parent = 'content';
    for (let depth = 3; depth <= 26; depth++) {
      const id = `generated-depth-${depth}`;
      deepNodes.push({...node(id, '', '', parent), role: 'android.view.View'});
      parent = id;
      if (depth === 24 || depth === 26) deepNodes.push(node(`generated-paragraph-${depth}`, '', `Generated historical paragraph at depth ${depth + 1}.`, parent));
    }
    add(`builtin-${rule.id}-historical-body-depth-25-27`, rule, deepNodes, s => Object.assign(s, historical),
      [page(rule, {...object, body: [{text: 'Generated historical paragraph at depth 25.'}, {text: 'Generated historical paragraph at depth 27.'}]})]);
  } else {
    named('path-index-missing', s => {delete s.nodes.find(n => n.id === 'title-parent').childIndex;});
    named('path-index-changed', s => {s.nodes.find(n => n.id === 'title-parent').childIndex = 2;});
    named('path-endpoint-wrong-role', s => {s.nodes.find(n => n.id === 'title').role = 'android.widget.Button';});
    named('path-filter-does-not-shift-index', s => {s.nodes = s.nodes.filter(n => n.id !== 'price');}, [page(rule, object)]);
    named('card-with-wrong-direct-parent', s => {s.nodes.find(n => n.id === 'card').parentId = 'wrapper';});
  }
}
const text = JSON.stringify(cases, null, 2) + '\n';
const destination = new URL('adapters/ui/fixtures/structured-conformance.json', root);
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== text) throw Error('Structured fixtures are stale; run node scripts/generate-ui-structured-fixtures.mjs');
} else writeFileSync(destination, text);
