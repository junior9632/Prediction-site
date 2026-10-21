'use strict';

/**
 * MINI DOM — a deliberately small, dependency-free DOM double used to execute
 * the REAL browser scripts (public/js/*.js) against the REAL Express app.
 *
 * WHY
 *   The dashboard bugs that hurt most were client-side wiring bugs (a table
 *   re-rendered without re-binding its buttons; a details panel whose id never
 *   matched). Asserting markup in a `.html` file does not catch those: the code
 *   has to RUN. This project ships no DOM library and takes no runtime
 *   dependency, so the tests execute the shipped file in a `vm` context — the
 *   same approach tests/fakeDb.js uses for MySQL (real code, faked environment).
 *
 * WHAT IT SUPPORTS (on purpose — nothing more)
 *   * a tolerant HTML parser for the fragments the pages render,
 *   * element tree + `querySelector`/`querySelectorAll`/`getElementById`
 *     with tag, `#id`, `.class`, `[attr]`, `[attr="v"]` and comma lists,
 *   * `innerHTML` (get/set), `insertAdjacentHTML`, `textContent`,
 *   * `classList`, `dataset`, `style`, `hidden`, `value`, `checked`, `open`,
 *   * `addEventListener`/`dispatchEvent`/`click()`/`onclick`,
 *   * `document.cookie`, `location`, `history`, `confirm`, form submission.
 *
 * It is a TEST HELPER: it never ships to the host and it is not a browser
 * simulator. Anything it cannot model should be asserted server-side instead.
 */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function escapeText(value) {
  return String(value === null || value === undefined ? '' : value);
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(source) {
  const attributes = {};
  let match;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : '';
    attributes[name] = value;
  }
  return attributes;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Parse an HTML fragment into a list of nodes.
 * Tolerant by design: unknown/unclosed tags are handled, `<script>` content is
 * skipped, entities are decoded in text nodes.
 */
function parseHtml(html, document) {
  const rootList = [];
  const stack = [];
  const source = String(html === null || html === undefined ? '' : html);
  let i = 0;

  const push = (node) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
      node.parentNode = parent;
    } else {
      rootList.push(node);
    }
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const text = source.slice(i);
      if (text) push(document.createTextNode(decodeEntities(text)));
      break;
    }
    if (lt > i) push(document.createTextNode(decodeEntities(source.slice(i, lt))));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end === -1 ? source.length : end).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].tagName === name) {
          stack.length = depth;
          break;
        }
      }
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    const raw = source.slice(lt + 1, end);
    const selfClosing = /\/\s*$/.test(raw);
    const body = selfClosing ? raw.replace(/\/\s*$/, '') : raw;
    const spaceAt = body.search(/[\s]/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attributes = spaceAt === -1 ? {} : parseAttributes(body.slice(spaceAt));
    const element = document.createElement(name);
    Object.assign(element.attributes, attributes);
    push(element);
    i = end + 1;

    if (name === 'script' || name === 'style') {
      const close = source.toLowerCase().indexOf(`</${name}`, i);
      const text = source.slice(i, close === -1 ? source.length : close);
      if (text) element.children.push(document.createTextNode(text));
      const after = close === -1 ? source.length : source.indexOf('>', close);
      i = after === -1 ? source.length : after + 1;
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
  }
  return rootList;
}

/** Find the closing `>` of a tag, ignoring `>` inside quoted attribute values. */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return source.length;
}

/* ------------------------------------------------------------------ */
/* elements                                                            */
/* ------------------------------------------------------------------ */

function serialize(node) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeText(node.data).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrs = Object.entries(node.attributes || {})
    .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${String(value).replace(/"/g, '&quot;')}"`))
    .join('');
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attrs}>`;
  return `<${node.tagName}${attrs}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}

class MiniNode {
  constructor(tagName, document) {
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toLowerCase();
    this.ownerDocument = document;
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    };
    this._textContent = null;
  }

  /* ------------------------------ attributes --------------------- */
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = String(value); }
  getAttribute(name) { const value = this.attributes[String(name).toLowerCase()]; return value === undefined ? null : value; }
  setAttribute(name, value) { this.attributes[String(name).toLowerCase()] = String(value); }
  removeAttribute(name) { delete this.attributes[String(name).toLowerCase()]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, String(name).toLowerCase()); }

  get dataset() {
    const node = this;
    return new Proxy({}, {
      get(_target, key) {
        return node.attributes[`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`];
      },
      set(_target, key, value) {
        node.attributes[`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`] = String(value);
        return true;
      },
      has(_target, key) {
        return Object.prototype.hasOwnProperty.call(node.attributes, `data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
      },
      ownKeys() {
        return Object.keys(node.attributes)
          .filter((name) => name.startsWith('data-'))
          .map((name) => name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()));
      },
      getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
    });
  }

  get classList() {
    const node = this;
    const read = () => String(node.attributes.class || '').split(/\s+/).filter(Boolean);
    const write = (list) => { node.attributes.class = [...new Set(list)].join(' '); };
    return {
      contains: (name) => read().includes(name),
      add: (...names) => write([...read(), ...names]),
      remove: (...names) => write(read().filter((c) => !names.includes(c))),
      toggle: (name, force) => {
        const has = read().includes(name);
        const next = typeof force === 'boolean' ? force : !has;
        if (next && !has) write([...read(), name]);
        if (!next && has) write(read().filter((c) => c !== name));
        return next;
      },
      get value() { return read().join(' '); },
    };
  }

  /**
   * Form-field semantics, enough for the dashboards: an `<input>` reads its
   * value attribute (empty string when absent — `undefined` would make real
   * page code throw), a `<select>` reports its first/selected option, and a
   * checkbox reports `checked`.
   */
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'option') return this.attributes.value !== undefined ? this.attributes.value : this.textContent.trim();
    if (this.tagName === 'select') {
      const options = this.getElementsByTagName('option');
      const selected = options.find((option) => option.hasAttribute('selected')) || options[0];
      return selected ? selected.value : '';
    }
    if (this.tagName === 'textarea') return this.textContent;
    return this.attributes.value !== undefined ? this.attributes.value : '';
  }
  set value(next) { this._value = String(next === null || next === undefined ? '' : next); }

  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
  set checked(next) { this._checked = Boolean(next); }

  get disabled() { return this._disabled !== undefined ? this._disabled : this.hasAttribute('disabled'); }
  set disabled(next) { this._disabled = Boolean(next); }

  get open() { return this._open !== undefined ? this._open : this.hasAttribute('open'); }
  set open(next) { this._open = Boolean(next); }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get textContent() {
    if (this._textContent !== null) return this._textContent;
    return this.children.map((child) => (child.nodeType === 3 ? child.data : child.textContent)).join('');
  }
  set textContent(value) {
    this.children = [];
    if (value !== null && value !== undefined && String(value) !== '') {
      const text = this.ownerDocument.createTextNode(String(value));
      text.parentNode = this;
      this.children.push(text);
    }
    this._textContent = null;
  }

  get innerHTML() { return this.children.map(serialize).join(''); }
  set innerHTML(html) {
    this._textContent = null;
    this.children = [];
    const nodes = parseHtml(html, this.ownerDocument);
    nodes.forEach((node) => { node.parentNode = this; });
    this.children = nodes;
  }

  get outerHTML() { return serialize(this); }

  insertAdjacentHTML(_position, html) {
    const nodes = parseHtml(html, this.ownerDocument);
    nodes.forEach((node) => { node.parentNode = this; });
    this.children.push(...nodes);
    this._textContent = null;
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  /* ------------------------------ traversal ---------------------- */
  _walk(out = []) {
    this.children.forEach((child) => {
      if (child.nodeType !== 1) return;
      out.push(child);
      child._walk(out);
    });
    return out;
  }

  querySelectorAll(selector) { return this.ownerDocument._select(selector, this); }
  querySelector(selector) { return this._selectFirst(selector); }
  _selectFirst(selector) { return this.ownerDocument._select(selector, this)[0] || null; }
  getElementsByTagName(name) { return this._walk().filter((node) => node.tagName === String(name).toLowerCase()); }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.ownerDocument._matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  /* ------------------------------ events ------------------------- */
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler);
  }
  dispatchEvent(event) {
    const payload = Object.assign({ type: event.type, target: this, currentTarget: this, defaultPrevented: false }, event, {
      preventDefault() { payload.defaultPrevented = true; if (event.preventDefault) event.preventDefault.call(this); },
      stopPropagation() {},
    });
    (this.listeners[payload.type] || []).forEach((fn) => fn(payload));
    const inline = this[`on${payload.type}`];
    if (typeof inline === 'function') inline(payload);
    return !payload.defaultPrevented;
  }
  click() {
    const payload = { type: 'click', target: this, preventDefault() { payload.defaultPrevented = true; } };
    const inline = this.onclick;
    if (typeof inline === 'function') inline(payload);
    (this.listeners.click || []).forEach((fn) => fn(payload));
    return !payload.defaultPrevented;
  }
  submit() {
    const payload = { type: 'submit', target: this, defaultPrevented: false, preventDefault() { payload.defaultPrevented = true; } };
    (this.listeners.submit || []).forEach((fn) => fn(payload));
    const inline = this.onsubmit;
    if (typeof inline === 'function') inline(payload);
    return !payload.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  scrollTo() {}
  reportValidity() { return true; }
  checkValidity() { return true; }
}

/* ------------------------------------------------------------------ */
/* document / window                                                   */
/* ------------------------------------------------------------------ */

class MiniDocument {
  constructor() {
    this.nodeType = 9;
    this.documentElement = new MiniNode('html', this);
    this.head = new MiniNode('head', this);
    this.body = new MiniNode('body', this);
    this.documentElement.children.push(this.head, this.body);
    this.head.parentNode = this.documentElement;
    this.body.parentNode = this.documentElement;
    this.listeners = {};
    this.cookie = '';
    this.title = '';
    this.readyState = 'loading';
    this.activeElement = null;
  }

  createElement(tagName) { return new MiniNode(tagName, this); }
  createTextNode(data) { return { nodeType: 3, data: String(data), parentNode: null }; }

  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler);
  }
  dispatchEvent(event) {
    if (event && typeof event === 'object' && event.type) return this.dispatch(event.type, event);
    return this.dispatch(String(event));
  }
  dispatch(type, payload = {}) {
    /* keydown/keyup handlers read event.key, so the payload must survive the hop */
    const event = Object.assign(
      { type, target: this, preventDefault() {}, stopPropagation() {} },
      payload,
      { type, target: this },
    );
    (this.listeners[type] || []).slice().forEach((fn) => fn(event));
    return true;
  }

  _all() { return this.documentElement._walk(); }

  _matches(node, selector) {
    return String(selector)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => matchesCompound(node, part));
  }

  _select(selector, scope) {
    const base = scope && scope !== this ? scope._walk() : this._all();
    return base.filter((node) => this._matches(node, selector));
  }

  querySelectorAll(selector) { return this._select(selector, this); }
  querySelector(selector) { return this._select(selector, this)[0] || null; }
  getElementById(id) { return this._all().find((node) => node.id === String(id)) || null; }
  getElementsByTagName(name) { return this._all().filter((node) => node.tagName === String(name).toLowerCase()); }
  getElementsByClassName(name) { return this._all().filter((node) => node.classList.contains(name)); }
  createDocumentFragment() { return new MiniNode('#fragment', this); }
}

/**
 * Match one compound selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`
 * and any combination of them (`details.pick-detail`, `.side-link[data-view]`).
 * Descendant combinators are intentionally not supported — the pages use single
 * compound selectors only.
 */
function matchesCompound(node, selector) {
  const text = String(selector).trim();
  if (!text) return false;
  const tokens = text.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g);
  if (!tokens) return false;
  let tag = null;
  for (const token of tokens) {
    if (token.startsWith('#')) {
      if (node.id !== token.slice(1)) return false;
    } else if (token.startsWith('.')) {
      if (!node.classList.contains(token.slice(1))) return false;
    } else if (token.startsWith('[')) {
      const body = token.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) {
        if (!node.hasAttribute(body.trim())) return false;
      } else {
        const name = body.slice(0, eq).trim().toLowerCase();
        const expected = body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (String(node.getAttribute(name)) !== expected) return false;
      }
    } else {
      tag = token.toLowerCase();
      if (node.tagName !== tag) return false;
    }
  }
  return tag !== null || tokens.length > 0;
}

/* ------------------------------------------------------------------ */
/* http client with a cookie jar (talks to the real Express app)       */
/* ------------------------------------------------------------------ */

function createCookieJar() {
  /** name -> { value, httpOnly } — a browser hides HttpOnly cookies from JS. */
  const cookies = new Map();
  return {
    set(name, value, { httpOnly = false } = {}) { cookies.set(name, { value, httpOnly }); },
    get(name) { return cookies.has(name) ? cookies.get(name).value : null; },
    header() {
      return [...cookies.entries()].map(([name, entry]) => `${name}=${entry.value}`).join('; ');
    },
    all() { return Object.fromEntries([...cookies.entries()].map(([name, entry]) => [name, entry.value])); },
    /** What `document.cookie` sees: every cookie that is not HttpOnly. */
    documentCookie() {
      return [...cookies.entries()]
        .filter(([, entry]) => !entry.httpOnly)
        .map(([name, entry]) => `${name}=${entry.value}`)
        .join('; ');
    },
    /** A page script assigning document.cookie = "a=b" adds a JS cookie. */
    setFromDocument(text) {
      String(text).split(';').forEach((pair) => {
        const index = pair.indexOf('=');
        if (index > 0) cookies.set(pair.slice(0, index).trim(), { value: pair.slice(index + 1).trim(), httpOnly: false });
      });
    },
    clear() { cookies.clear(); },
    absorb(response) {
      const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const line of raw) {
        const parts = String(line).split(';');
        const pair = parts.shift();
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        const httpOnly = parts.some((attribute) => /^\s*httponly\s*$/i.test(attribute));
        cookies.set(pair.slice(0, index).trim(), { value: pair.slice(index + 1).trim(), httpOnly });
      }
    },
  };
}

function createFetch(baseUrl, jar, hooks = {}) {
  return async function fetchDouble(input, init = {}) {
    const url = String(input).startsWith('http') ? String(input) : `${baseUrl}${String(input).startsWith('/') ? '' : '/'}${input}`;
    const headers = Object.assign({}, init.headers || {});
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const method = (init.method || 'GET').toUpperCase();
    if (hooks.record) hooks.record({ url, method, body: init.body, headers });
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    jar.absorb(response);
    if (hooks.onResponse) hooks.onResponse(response, { url, method });
    return response;
  };
}

/* ------------------------------------------------------------------ */
/* page runner                                                         */
/* ------------------------------------------------------------------ */

/**
 * Boot one page: real HTML markup + the real scripts, in a shared context.
 *
 * @param {{markup?: string, scripts: Array<{file?: string, code?: string}>,
 *          baseUrl: string, jar: object, search?: string, hash?: string,
 *          confirm?: Function, prompt?: Function, fetch?: Function}} options
 */
async function createPage(options) {
  const { baseUrl, jar, scripts } = options;
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');

  const document = new MiniDocument();
  if (options.markup) {
    document.documentElement.innerHTML = options.markup;
    // documentElement.innerHTML replaces the tree; re-seat the well-known nodes
    document.head = document.documentElement.children.find((n) => n.tagName === 'head') || document.head;
    document.body = document.documentElement.children.find((n) => n.tagName === 'body') || document.body;
  }

  // A real browser exposes the non-HttpOnly cookies to page scripts. The shared
  // API helper reads `document.cookie` for the CSRF double-submit token, so a
  // harness without this would fail every mutating request (and hide real ones).
  if (jar) {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() { return jar.documentCookie(); },
      set(value) { jar.setFromDocument(value); },
    });
  }

  const confirmCalls = [];
  const prompts = [];
  const navigations = [];
  const location = {
    pathname: options.pathname || '/',
    search: options.search || '',
    hash: options.hash || '',
    get href() { return `${this.pathname}${this.search}${this.hash}`; },
    set href(value) { navigations.push({ type: 'assign', url: String(value) }); },
    replace(url) { navigations.push({ type: 'replace', url: String(url) }); },
    assign(url) { navigations.push({ type: 'assign', url: String(url) }); },
    reload() { navigations.push({ type: 'reload' }); },
  };

  const historyStack = [location.href];
  const history = {
    pushState(_state, _title, url) { if (url) setUrl(url); historyStack.push(location.href); },
    replaceState(_state, _title, url) { if (url) setUrl(url); },
    back() {},
    get length() { return historyStack.length; },
  };

  function setUrl(url) {
    const text = String(url);
    const hashAt = text.indexOf('#');
    const withoutHash = hashAt === -1 ? text : text.slice(0, hashAt);
    const queryAt = withoutHash.indexOf('?');
    location.pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
    location.search = queryAt === -1 ? '' : withoutHash.slice(queryAt);
    location.hash = hashAt === -1 ? '' : text.slice(hashAt);
  }

  const windowListeners = {};
  const fetchImpl = options.fetch || createFetch(baseUrl, jar);

  const windowDouble = {
    location,
    history,
    document,
    navigator: { userAgent: 'mini-dom-test', clipboard: null },
    innerWidth: options.innerWidth || 1280,
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn); },
    dispatch(type, payload = {}) {
      (windowListeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type, target: windowDouble }, payload)));
    },
    confirm(message) {
      confirmCalls.push(String(message));
      return options.confirm ? options.confirm(String(message)) : true;
    },
    prompt(message) {
      prompts.push(String(message));
      return options.prompt ? options.prompt(String(message)) : null;
    },
    alert(message) { confirmCalls.push(`ALERT:${message}`); },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    fetch: fetchImpl,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    scrollTo() {},
    open() { return null; },
    URLSearchParams,
    URL,
    Intl,
    FormData: class FormData {},
  };
  windowDouble.window = windowDouble;
  windowDouble.self = windowDouble;
  windowDouble.globalThis = windowDouble;

  const context = vm.createContext({
    window: windowDouble,
    document,
    navigator: windowDouble.navigator,
    location,
    history,
    fetch: fetchImpl,
    confirm: windowDouble.confirm,
    prompt: windowDouble.prompt,
    alert: windowDouble.alert,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: options.console || { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    URLSearchParams,
    URL,
    Intl,
    Math,
    JSON,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Map,
    Set,
    WeakMap,
    AbortController,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    Symbol,
  });

  const errors = [];
  const load = (script) => {
    const code = script.file
      ? fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', script.file), 'utf8')
      : script.code;
    try {
      vm.runInContext(code, context, { filename: script.file || 'inline.js' });
    } catch (err) {
      errors.push(err);
      throw err;
    }
  };
  scripts.forEach(load);

  const page = {
    window: windowDouble,
    document,
    context,
    errors,
    navigations,
    confirmCalls,
    prompts,
    cookie: jar,
    $(selector) { return document.querySelector(selector); },
    $$(selector) { return document.querySelectorAll(selector); },
    html(selector) {
      const node = typeof selector === 'string' ? document.querySelector(selector) : selector;
      return node ? node.innerHTML : null;
    },
    text(selector) {
      const node = typeof selector === 'string' ? document.querySelector(selector) : selector;
      return node ? node.textContent : null;
    },
    navigated(url) { return navigations.some((entry) => entry.url === url); },
    async domReady() { document.dispatchEvent('DOMContentLoaded'); await flush(); },
    setHash(hash) { setUrl(`#${hash}`); windowDouble.dispatch('hashchange'); },
    fire(target, type, payload) {
      const node = typeof target === 'string' ? document.querySelector(target) : target;
      if (!node) throw new Error(`mini-dom: nothing matches ${target}`);
      return node.dispatchEvent(Object.assign({ type }, payload));
    },
    submit(selector) {
      const form = document.querySelector(selector);
      if (!form) throw new Error(`mini-dom: no form matches ${selector}`);
      return form.submit();
    },
    click(selector) {
      const node = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!node) throw new Error(`mini-dom: nothing clickable matches ${selector}`);
      return node.click();
    },
    type(selector, value) {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`mini-dom: no field matches ${selector}`);
      node.value = value;
      return node.dispatchEvent({ type: 'input' });
    },
    change(selector, value) {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`mini-dom: no field matches ${selector}`);
      if (value !== undefined) node.value = value;
      return node.dispatchEvent({ type: 'change' });
    },
    check(selector, checked) {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`mini-dom: no checkbox matches ${selector}`);
      node.checked = checked;
      return node.dispatchEvent({ type: 'change' });
    },
    async settle(ms = 0) { await flush(ms); },
  };

  return page;
}

/** Let promise chains and (optionally) timers settle. */
function flush(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(() => setImmediate(resolve), ms);
  });
}

/** Poll until `predicate` is true or the budget runs out (for polling UIs). */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await flush(stepMs);
  }
}

module.exports = {
  MiniDocument,
  MiniNode,
  parseHtml,
  createPage,
  createCookieJar,
  createFetch,
  flush,
  waitFor,
  matchesCompound,
};
