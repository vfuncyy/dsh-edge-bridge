/**
 * Functions injected into the page by chrome.scripting.executeScript.
 *
 * Every function here must be completely self-contained: the browser
 * serialises it with Function.prototype.toString and runs it in a fresh
 * world, so it may only use its single argument and page globals.
 */

/** Read the page and return a Markdown / text / HTML report. */
export function readPage(options) {
  const opts = options || {};
  const format = opts.format === 'text' || opts.format === 'html' ? opts.format : 'markdown';
  const maxChars = Math.max(1000, Math.min(6000000, Number(opts.maxChars) || 20000));
  const includeLinks = opts.includeLinks === true;
  const scope = typeof opts.scope === 'string' && opts.scope.trim() ? opts.scope.trim() : 'auto';
  const drop = new Set(
    String(opts.dropTags || 'script,style,noscript,template,svg,canvas,iframe,nav,footer,aside')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dd', 'dt', 'fieldset', 'figcaption', 'figure',
    'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
    'pre', 'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul',
  ]);
  const normalize = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  let root = null;
  let strategy = scope;
  if (scope === 'body') {
    root = document.body;
  } else if (scope === 'main') {
    root = document.querySelector('main, article, [role="main"]') || document.body;
  } else if (scope === 'auto') {
    const candidates = ['main', 'article', '[role="main"]', '#content', '#main', '.content', '.post', '.article'];
    let best = null;
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element && element.innerText && element.innerText.trim().length > 200) {
        best = element;
        break;
      }
    }
    root = best || document.body;
    strategy = best ? `auto:${best.tagName.toLowerCase()}` : 'auto:body';
  } else {
    root = document.querySelector(scope);
    if (!root) return { ok: false, error: `no element matches selector ${scope}` };
  }
  if (!root) return { ok: false, error: 'the page has no readable body yet (it may still be loading)' };

  function renderChildren(node) {
    let out = '';
    for (const child of Array.from(node.childNodes)) out += renderNode(child);
    return out;
  }

  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 2000);
    const grid = rows
      .map((row) => Array.from(row.children).map((cell) => normalize(renderChildren(cell)).replace(/\|/g, '\\|')))
      .filter((row) => row.length > 0);
    if (grid.length === 0) return '';
    const width = Math.max(...grid.map((row) => row.length));
    const pad = (row) => {
      const cells = row.slice();
      while (cells.length < width) cells.push('');
      return `| ${cells.join(' | ')} |`;
    };
    const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
    return `\n\n${[pad(grid[0]), separator, ...grid.slice(1).map(pad)].join('\n')}\n\n`;
  }

  function renderNode(node) {
    if (node.nodeType === 3) return String(node.nodeValue || '').replace(/[ \t\r\n]+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (drop.has(tag)) return '';
    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'img': {
        const alt = normalize(node.getAttribute('alt'));
        const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
        // Inline data URIs are UI icons (often tens of kilobytes each); they
        // are noise in a capture and would swamp the real body text.
        if (!src || /^data:/i.test(src)) return alt ? alt : '';
        return `![${alt}](${absolute(src)})`;
      }
      case 'a': {
        const text = normalize(renderChildren(node));
        const href = node.getAttribute('href') || '';
        if (!text) return '';
        if (!href || href.startsWith('#')) return text;
        return `[${text}](${absolute(href)})`;
      }
      case 'pre': {
        const code = String(node.textContent || '').replace(/\n+$/, '');
        return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
      }
      case 'code': {
        if (node.closest && node.closest('pre')) return String(node.textContent || '');
        const text = String(node.textContent || '');
        return text ? `\`${text}\`` : '';
      }
      case 'strong':
      case 'b': {
        const text = normalize(renderChildren(node));
        return text ? `**${text}**` : '';
      }
      case 'em':
      case 'i': {
        const text = normalize(renderChildren(node));
        return text ? `*${text}*` : '';
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return `\n\n${'#'.repeat(Number(tag.slice(1)))} ${normalize(renderChildren(node))}\n\n`;
      case 'li':
        return `\n- ${normalize(renderChildren(node))}`;
      case 'blockquote':
        return `\n\n> ${normalize(renderChildren(node)).replace(/\n/g, '\n> ')}\n\n`;
      case 'table':
        return renderTable(node);
      case 'dt':
        return `\n**${normalize(renderChildren(node))}**`;
      case 'dd':
        return `\n: ${normalize(renderChildren(node))}`;
      default: {
        const inner = renderChildren(node);
        if (BLOCK.has(tag)) return `\n\n${inner.trim()}\n\n`;
        return inner;
      }
    }
  }

  function renderScope(node) {
    if (format === 'text') {
      return String(node.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    if (format === 'html') {
      const clone = node.cloneNode(true);
      for (const tag of drop) for (const element of Array.from(clone.querySelectorAll(tag))) element.remove();
      return String(clone.innerHTML || '');
    }
    const clone = node.cloneNode(true);
    for (const tag of drop) for (const element of Array.from(clone.querySelectorAll(tag))) element.remove();
    for (const element of Array.from(clone.querySelectorAll('[hidden]'))) element.remove();
    return renderNode(clone).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
  }

  let text = renderScope(root);

  // `auto` can pick a wrapper (`#content`) that misses the real article. When
  // the chosen scope holds far less text than the whole page, fall back to
  // <body> so a capture keeps the full article body instead of a stub.
  if (scope === 'auto' && strategy !== 'auto:body' && document.body) {
    const bodyLength = String(document.body.innerText || '').replace(/\s+/g, ' ').trim().length;
    if (bodyLength > 1500 && text.length < bodyLength * 0.5) {
      const full = renderScope(document.body);
      if (full.length > text.length) {
        text = full;
        root = document.body;
        strategy = 'auto:body(fallback)';
      }
    }
  }

  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  const outline = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .slice(0, 80)
    .map((heading) => ({ level: Number(heading.tagName.slice(1)), text: normalize(heading.innerText).slice(0, 160) }))
    .filter((heading) => heading.text.length > 0);

  let links = [];
  if (includeLinks) {
    const seen = new Set();
    for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
      const href = absolute(anchor.getAttribute('href'));
      if (!/^https?:/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: normalize(anchor.innerText || anchor.textContent).slice(0, 200), href });
      if (links.length >= 200) break;
    }
  }

  const meta = (name) => {
    const element =
      document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
    return element ? normalize(element.getAttribute('content')) : '';
  };

  return {
    ok: true,
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || '',
    description: meta('description') || meta('og:description'),
    siteName: meta('og:site_name'),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '',
    format,
    scope: strategy,
    charCount: text.length,
    truncated,
    text,
    outline,
    links,
    fullTextLength: format === 'text' ? text.length : String(root.textContent || '').length,
    canvasCount: document.querySelectorAll('canvas').length,
  };
}

/** Perform one interaction in the page and report what was touched. */
export function actPage(options) {
  const opts = options || {};
  const action = String(opts.action || '');
  const selector = typeof opts.selector === 'string' ? opts.selector.trim() : '';
  const ref = typeof opts.ref === 'string' ? opts.ref.trim() : '';
  const text = typeof opts.text === 'string' ? opts.text : '';
  const normalize = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  /**
   * A cheap page fingerprint: enough to tell "nothing changed" from "the DOM moved".
   *
   * The element count alone misses the most common outcome of a click — a page that
   * rewrites the text of a node it already had (a counter, a result box, a toast).
   * Hashing the first slice of body text catches that without walking every node;
   * the text length rides along so a change past the slice still shows up.
   */
  function fingerprint() {
    try {
      const body = document.body;
      const elements = body ? body.getElementsByTagName('*').length : 0;
      const text = body ? body.innerText || '' : '';
      const limit = Math.min(text.length, 20000);
      let hash = 5381;
      for (let i = 0; i < limit; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
      return `${document.title}|${location.href}|${elements}|${text.length}|${hash}`;
    } catch {
      return '';
    }
  }

  function byRef(token) {
    try {
      return document.querySelector(`[data-dsh-ref="${String(token).replace(/["\\]/g, '\\$&')}"]`);
    } catch {
      return null;
    }
  }

  /** Check the caller's expectations before touching anything. */
  function expectFailures(element) {
    const expect = opts.expect;
    if (!expect || typeof expect !== 'object') return [];
    const failures = [];
    if (typeof expect.text === 'string') {
      const actual = normalize(element.innerText);
      if (actual !== normalize(expect.text)) failures.push({ check: 'text', expected: normalize(expect.text), actual });
    }
    if (typeof expect.value === 'string') {
      const actual = normalize(element.value);
      if (actual !== normalize(expect.value)) failures.push({ check: 'value', expected: normalize(expect.value), actual });
    }
    if (typeof expect.checked === 'boolean') {
      const actual = Boolean(element.checked);
      if (actual !== expect.checked) failures.push({ check: 'checked', expected: expect.checked, actual });
    }
    const attribute = expect.attribute;
    if (attribute && typeof attribute === 'object' && typeof attribute.name === 'string') {
      const actual = normalize(element.getAttribute(attribute.name));
      const expected = normalize(attribute.value == null ? '' : attribute.value);
      if (actual !== expected) failures.push({ check: `@${attribute.name}`, expected, actual });
    }
    return failures;
  }

  function describeExpectation(failures) {
    const first = failures[0];
    const actual = typeof first.actual === 'string' ? JSON.stringify(first.actual) : String(first.actual);
    const more = failures.length > 1 ? ` (and ${failures.length - 1} more condition(s) failed)` : '';
    return `expectation failed: expected ${first.check} ${JSON.stringify(first.expected)} but the target has ${actual}${more} — nothing was done`;
  }

  function visible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function describe(element) {
    if (!element) return { tag: '', text: '' };
    const detail = {
      tag: element.tagName.toLowerCase(),
      text: normalize(element.innerText || element.value || '').slice(0, 200),
      selector,
    };
    const token = element.getAttribute && element.getAttribute('data-dsh-ref');
    if (token) detail.ref = token;
    return detail;
  }

  function byText(needleText) {
    const needle = normalize(needleText).toLowerCase();
    if (!needle) return null;
    const candidates = Array.from(
      document.querySelectorAll(
        'a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,li,h1,h2,h3,h4,h5,h6,td,span,div,p',
      ),
    );
    const exact = candidates.find((element) => visible(element) && normalize(element.innerText || element.value).toLowerCase() === needle);
    if (exact) return exact;
    const partial = candidates.filter((element) => visible(element) && normalize(element.innerText || element.value).toLowerCase().includes(needle));
    partial.sort((left, right) => normalize(left.innerText).length - normalize(right.innerText).length);
    return partial[0] || null;
  }

  function resolveTarget() {
    if (ref) {
      const element = byRef(ref);
      if (!element) throw new Error(`no element with ref ${ref} — refs are stamped by the last edge_inspect in this page; re-run edge_inspect and use its ref`);
      return element;
    }
    if (selector) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`no element matches selector ${selector}`);
      return element;
    }
    if (text.trim()) {
      const element = byText(text);
      if (!element) throw new Error(`no visible element contains the text ${JSON.stringify(text)}`);
      return element;
    }
    throw new Error('pass ref, selector or text to identify the target element');
  }

  function fireMouse(element) {
    const base = { bubbles: true, cancelable: true, view: window, button: 0 };
    element.dispatchEvent(new MouseEvent('mouseover', base));
    element.dispatchEvent(new MouseEvent('mousedown', base));
    element.dispatchEvent(new MouseEvent('mouseup', base));
    if (typeof element.click === 'function') element.click();
    else element.dispatchEvent(new MouseEvent('click', base));
  }

  function fireKey(key) {
    const target = document.activeElement || document.body;
    const make = (type) =>
      new KeyboardEvent(type, {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
      });
    target.dispatchEvent(make('keydown'));
    target.dispatchEvent(make('keypress'));
    target.dispatchEvent(make('keyup'));
    return target;
  }

  function setValue(element, value) {
    element.focus();
    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, value);
      } catch {
        inserted = false;
      }
      if (!inserted) element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      return;
    }
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Element state before/after an interaction, so the caller can tell a real
   * commit from an action that was merely dispatched.
   */
  function snapshot(element) {
    if (!element || !element.tagName) return null;
    return {
      value: 'value' in element ? String(element.value ?? '') : '',
      checked: 'checked' in element ? Boolean(element.checked) : undefined,
      text: normalize(element.innerText).slice(0, 120),
    };
  }

  function effectOf(beforeState, beforePrint, element) {
    if (fingerprint() !== beforePrint) return { state: 'committed', reason: 'the page changed immediately' };
    const after = snapshot(element);
    if (beforeState && after) {
      if (after.value !== beforeState.value) return { state: 'committed', reason: 'the field value changed' };
      if (after.checked !== beforeState.checked) return { state: 'committed', reason: 'the checked state changed' };
      if (after.text !== beforeState.text) return { state: 'committed', reason: 'the element text changed' };
    }
    return {
      state: 'unknown',
      reason: 'the action was dispatched but nothing changed yet — the page may still be reacting (navigation, request, animation). Do not blindly repeat it; read or inspect the page first.',
    };
  }

  try {
    if (action === 'click') {
      const element = resolveTarget();
      const failures = expectFailures(element);
      if (failures.length > 0) return { ok: false, error: describeExpectation(failures), effect: { state: 'none', reason: 'the expectation failed before the click' } };
      const beforeState = snapshot(element);
      const beforePrint = fingerprint();
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const detail = describe(element);
      fireMouse(element);
      return { ok: true, detail, effect: effectOf(beforeState, beforePrint, element) };
    }
    if (action === 'hover') {
      const element = resolveTarget();
      const failures = expectFailures(element);
      if (failures.length > 0) return { ok: false, error: describeExpectation(failures), effect: { state: 'none', reason: 'the expectation failed before the hover' } };
      const beforeState = snapshot(element);
      const beforePrint = fingerprint();
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const base = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new MouseEvent('mouseover', base));
      element.dispatchEvent(new MouseEvent('mouseenter', base));
      element.dispatchEvent(new MouseEvent('mousemove', base));
      return { ok: true, detail: describe(element), effect: effectOf(beforeState, beforePrint, element) };
    }
    if (action === 'type') {
      const element = ref || selector ? resolveTarget() : document.activeElement;
      if (!element || element === document.body) throw new Error('no focused field to type into: pass a ref or a selector');
      const failures = expectFailures(element);
      if (failures.length > 0) return { ok: false, error: describeExpectation(failures), effect: { state: 'none', reason: 'the expectation failed before typing' } };
      const beforeState = snapshot(element);
      const beforePrint = fingerprint();
      setValue(element, text);
      if (opts.submit === true) {
        fireKey('Enter');
        const form = element.form || (element.closest ? element.closest('form') : null);
        if (form && typeof form.requestSubmit === 'function') {
          try {
            form.requestSubmit();
          } catch {
            /* some forms refuse programmatic submission */
          }
        }
      }
      return { ok: true, detail: { ...describe(element), text: text.slice(0, 200) }, effect: effectOf(beforeState, beforePrint, element) };
    }
    if (action === 'select') {
      const element = resolveTarget();
      const failures = expectFailures(element);
      if (failures.length > 0) return { ok: false, error: describeExpectation(failures), effect: { state: 'none', reason: 'the expectation failed before selecting' } };
      if (!(element instanceof HTMLSelectElement)) throw new Error('the target element is not a <select>');
      const beforeState = snapshot(element);
      const beforePrint = fingerprint();
      const wanted = normalize(text).toLowerCase();
      const option =
        Array.from(element.options).find((candidate) => candidate.value === text) ||
        Array.from(element.options).find((candidate) => normalize(candidate.textContent).toLowerCase() === wanted) ||
        Array.from(element.options).find((candidate) => normalize(candidate.textContent).toLowerCase().includes(wanted));
      if (!option) throw new Error(`no option matches ${JSON.stringify(text)}`);
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: { tag: 'select', text: normalize(option.textContent), selector }, effect: effectOf(beforeState, beforePrint, element) };
    }
    if (action === 'press') {
      const key = text || 'Enter';
      const beforePrint = fingerprint();
      const target = fireKey(key);
      const form = target && target.form;
      if (key === 'Enter' && form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
        } catch {
          /* ignore */
        }
      }
      return { ok: true, detail: { tag: 'key', text: key }, effect: effectOf(null, beforePrint, target) };
    }
    if (action === 'scroll') {
      const before = window.scrollY;
      if (Number.isFinite(opts.amount) && opts.amount !== 0) {
        window.scrollBy({ top: opts.amount, behavior: 'instant' });
      } else {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      }
      return {
        ok: true,
        detail: {
          tag: 'window',
          text: `scrolled ${Math.round(window.scrollY - before)}px; y=${Math.round(window.scrollY)} of ${document.documentElement.scrollHeight}`,
        },
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
      };
    }
    if (action === 'wait') {
      const element = ref ? byRef(ref) : selector ? document.querySelector(selector) : byText(text);
      return { ok: true, found: Boolean(element), detail: describe(element) };
    }
    return { ok: false, error: `unsupported action ${action}` };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * Map a page without reading it: the containers that look like result lists or
 * tables, the controls a click needs, and a ready-to-use CSS selector for each.
 *
 * This exists because finding selectors by trial and error costs one whole
 * model turn per guess; one structural dump answers "what can I click here"
 * and "where is the table" together.
 */
export function inspectPage(options) {
  const opts = options || {};
  const maxInteractive = Math.max(1, Math.min(400, Number(opts.maxInteractive) || 80));
  const maxLists = Math.max(0, Math.min(40, Number(opts.maxLists) || 12));
  const scopeSelector = typeof opts.selector === 'string' && opts.selector.trim() ? opts.selector.trim() : '';
  const normalize = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!root) return { ok: false, error: `no element matches selector ${scopeSelector}` };

  const escapeName = (value) =>
    window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

  function unique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function selectorFor(element) {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) {
      const byId = `#${escapeName(element.id)}`;
      if (unique(byId)) return byId;
    }
    for (const attribute of ['data-testid', 'data-id', 'name', 'aria-label', 'placeholder', 'title']) {
      const value = element.getAttribute(attribute);
      if (!value || value.length > 40) continue;
      const selector = `${element.tagName.toLowerCase()}[${attribute}="${String(value).replace(/"/g, '\\"')}"]`;
      if (unique(selector)) return selector;
    }
    const parts = [];
    let node = element;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      const tag = node.tagName.toLowerCase();
      if (node.id && depth > 0) {
        parts.unshift(`#${escapeName(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05;
  }

  /**
   * Stamp a stable handle on the element so the next edge_act can aim at it
   * without replaying a selector that may already point somewhere else.
   */
  const usedRefs = new Set(
    Array.from(document.querySelectorAll('[data-dsh-ref]'))
      .map((node) => node.getAttribute('data-dsh-ref'))
      .filter(Boolean),
  );
  let refSeq = 0;
  function refFor(element) {
    const existing = element.getAttribute && element.getAttribute('data-dsh-ref');
    if (existing) return existing;
    let token = '';
    do {
      refSeq += 1;
      token = `e${refSeq}`;
    } while (usedRefs.has(token) && refSeq < 5000);
    usedRefs.add(token);
    try {
      element.setAttribute('data-dsh-ref', token);
    } catch {
      /* non-HTML nodes may refuse attributes */
    }
    return token;
  }

  function label(element) {
    const candidates = [
      element.innerText,
      element.value,
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('placeholder'),
      element.getAttribute && element.getAttribute('title'),
      element.getAttribute && element.getAttribute('alt'),
    ];
    for (const candidate of candidates) {
      const text = normalize(candidate);
      if (text) return text;
    }
    return '';
  }

  const outline = [];
  for (const heading of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).slice(0, 80)) {
    const text = normalize(heading.innerText);
    if (text) outline.push({ level: Number(heading.tagName.slice(1)) || 1, text: text.slice(0, 120) });
  }

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="tab"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[onclick]',
    'summary',
  ].join(', ');

  const interactive = [];
  let matched = 0;
  let hidden = 0;
  for (const element of Array.from(root.querySelectorAll(INTERACTIVE))) {
    matched += 1;
    if (interactive.length >= maxInteractive) {
      hidden += 1;
      continue;
    }
    if (element.disabled === true) {
      hidden += 1;
      continue;
    }
    if (!visible(element)) {
      hidden += 1;
      continue;
    }
    const text = label(element);
    if (text.length > 160) {
      hidden += 1; // long text is content, not a control
      continue;
    }
    const rect = element.getBoundingClientRect();
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    const entry = {
      ref: refFor(element),
      tag: element.tagName.toLowerCase(),
      role,
      sel: selectorFor(element),
      text: text.slice(0, 120),
      y: Math.round(rect.top + window.scrollY),
    };
    const href = element.getAttribute('href');
    if (href) entry.href = String(href).slice(0, 200);
    const type = element.getAttribute('type');
    if (type) entry.type = type;
    if ('checked' in element && (entry.tag === 'input' || role === 'checkbox')) entry.checked = Boolean(element.checked);
    if (element.getAttribute('aria-expanded')) entry.expanded = element.getAttribute('aria-expanded');
    const value = 'value' in element ? String(element.value ?? '') : '';
    if (value && entry.tag !== 'select') entry.value = value.slice(0, 80);
    interactive.push(entry);
  }
  interactive.sort((left, right) => left.y - right.y);

  const lists = [];
  const claimed = [];
  function pushList(node, list) {
    if (lists.length >= maxLists) return;
    for (const other of claimed) {
      if (other === node || other.contains(node) || node.contains(other)) return;
    }
    claimed.push(node);
    lists.push(list);
  }

  const candidates = [];
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const bodyRows = table.querySelectorAll('tbody tr').length;
    const rows = bodyRows || table.querySelectorAll('tr').length;
    if (rows < 2) continue;
    const head = table.querySelector('thead tr') || table.querySelector('tr');
    const cells = head ? Array.from(head.querySelectorAll('th, td')).map((cell) => normalize(cell.innerText)).filter(Boolean) : [];
    const firstBodyRow = table.querySelector('tbody tr') || Array.from(table.querySelectorAll('tr'))[1] || null;
    const sampleCells = firstBodyRow ? Array.from(firstBodyRow.querySelectorAll('th, td')).map((cell) => normalize(cell.innerText)) : [];
    candidates.push({ node: table, rows, cols: cells.length || sampleCells.length, kind: 'table', sample: sampleCells.length > 0 ? [sampleCells.slice(0, 10)] : [] });
  }

  for (const parent of Array.from(root.querySelectorAll('ul, ol, dl, div, section, article, table'))) {
    const children = Array.from(parent.children);
    if (children.length < 4) continue;
    const groups = new Map();
    for (const child of children) {
      const key = `${child.tagName}.${String(child.className || '')}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const best = Array.from(groups.values()).sort((left, right) => right - left)[0] || 0;
    if (best < 4 || best < children.length * 0.6) continue;
    const sample = children
      .slice(0, 3)
      .map((child) => [normalize(child.innerText).slice(0, 80)])
      .filter((row) => row[0]);
    if (sample.length === 0) continue;
    candidates.push({ node: parent, rows: best, cols: 1, kind: 'repeat', sample });
  }
  candidates.sort((left, right) => right.rows - left.rows);
  for (const candidate of candidates) {
    pushList(candidate.node, {
      kind: candidate.kind,
      sel: selectorFor(candidate.node),
      rows: candidate.rows,
      cols: candidate.cols,
      sample: candidate.sample,
    });
  }

  return {
    ok: true,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    canvasCount: document.querySelectorAll('canvas').length,
    iframeCount: document.querySelectorAll('iframe').length,
    scrollHeight: document.documentElement.scrollHeight,
    outline,
    interactive,
    matchedInteractive: matched,
    hiddenInteractive: hidden,
    lists,
  };
}