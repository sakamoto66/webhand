(() => {
  if (!document.body) return null;

  // ---- Limits and vocabularies ----

  const TEXT_LIMIT = 6000;
  const MAX_ACTIONS = 250;
  const SCROLL_STEP = 560;

  const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const INTERACTIVE_SELECTOR = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    INTERACTIVE_ROLES.map(role => '[role="' + role + '"]').join(',');
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio',
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    search: 'searchbox', number: 'spinbutton',
    text: 'textbox', email: 'textbox', url: 'textbox', tel: 'textbox',
  };
  const TEXT_ROLES = ['textbox', 'searchbox', 'spinbutton'];
  const BUTTON_INPUT_TYPES = ['button', 'submit', 'reset'];
  // Values of these inputs are never read.
  const UNOBSERVED_INPUT_TYPES = ['password', 'file', 'hidden'];
  const HIDDEN_SELECTOR = '[aria-hidden="true"],[inert]';
  const FORM_FIELD_SELECTOR = 'input,textarea,select';
  // The surrounding region whose text is part of an element's freshness guard.
  const GUARD_SCOPE_SELECTOR = 'form,dialog,[role="dialog"],article,li,tr,[role="row"]';
  const NON_CONTENT_SELECTOR = 'script,style,noscript,template';

  // ---- Node ids (stable across snapshots of the same document) ----

  const state = window.__browserLab ||= {ids: new WeakMap(), nodes: new Map(), next: 1};

  const nodeId = element => {
    if (!state.ids.has(element)) state.ids.set(element, state.next++);
    const id = state.ids.get(element);
    state.nodes.set(id, element);
    return id;
  };

  const forgetDisconnected = () => {
    for (const [id, element] of state.nodes) {
      if (!element.isConnected) state.nodes.delete(id);
    }
  };
  forgetDisconnected();

  // ---- Flat-tree traversal ----
  // Open shadow roots are walked as part of the page. Closed roots are not reachable from page script.

  // NodeFilter.SHOW_* bits are 1 << (nodeType - 1).
  const matchesFilter = (node, whatToShow) => (1 << (node.nodeType - 1)) & whatToShow;

  const walkDeep = function* (root, whatToShow) {
    // Elements are always visited so that their shadow roots can be entered.
    const walker = document.createTreeWalker(root, whatToShow | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) yield* walkDeep(node.shadowRoot, whatToShow);
      if (matchesFilter(node, whatToShow)) yield node;
    }
  };

  const queryAllDeep = selector =>
    [...walkDeep(document, NodeFilter.SHOW_ELEMENT)].filter(element => element.matches(selector));

  // Like Element.closest, but continues from a shadow root to its host.
  const closestDeep = (element, selector) => {
    for (let current = element; current; current = current.getRootNode().host) {
      const found = current.closest(selector);
      if (found) return found;
    }
    return null;
  };

  // Slotted nodes belong to their slot, shadow roots to their host.
  const flatParent = node => node.assignedSlot || node.parentNode?.host || node.parentNode;

  const flatChildren = element => {
    if (element.shadowRoot) return [...element.shadowRoot.childNodes];
    if (element.tagName === 'SLOT' && element.assignedNodes().length) return element.assignedNodes({flatten: true});
    return [...element.childNodes];
  };

  // Like document.elementFromPoint, but descends into open shadow roots.
  const deepElementFromPoint = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  // ---- Element properties ----

  const isObservableInput = element => !UNOBSERVED_INPUT_TYPES.includes(element.type);

  const isVisible = element => !closestDeep(element, HIDDEN_SELECTOR) &&
    element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});

  const isDisabled = element => element.matches(':disabled') || closestDeep(element, '[aria-disabled="true"]');

  // A simplified accessible name computation. `seen` stops reference cycles.
  const accessibleName = (element, seen = new Set()) => {
    if (!element || seen.has(element)) return '';
    seen.add(element);
    const nameOf = node => accessibleName(node, seen);

    const referenced = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => nameOf(element.getRootNode().getElementById?.(id))).filter(Boolean).join(' ');
    if (referenced) return referenced;

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const labels = [...(element.labels || [])].map(nameOf).filter(Boolean).join(' ');
    if (labels) return labels;

    if (BUTTON_INPUT_TYPES.includes(element.type) && element.value) return element.value;

    const alt = element.getAttribute('alt');
    if (alt) return alt;

    if (element.tagName !== 'INPUT') {
      const content = flatChildren(element).map(child => {
        if (child.nodeType === Node.TEXT_NODE) return child.textContent;
        if (child.nodeType === Node.ELEMENT_NODE && child.getAttribute('aria-hidden') !== 'true') return nameOf(child);
        return '';
      }).join(' ').trim();
      if (content) return content;
    }

    return element.getAttribute('title') || element.getAttribute('placeholder') || '';
  };

  const roleOf = element => {
    const explicit = element.getAttribute('role');
    if (INTERACTIVE_ROLES.includes(explicit)) return explicit;
    switch (element.tagName) {
      case 'BUTTON':
      case 'SUMMARY': return 'button';
      case 'A': return 'link';
      case 'SELECT': return 'combobox';
      case 'TEXTAREA': return 'textbox';
    }
    if (element.isContentEditable) return 'textbox';
    if (element.tagName === 'INPUT') return INPUT_ROLES[element.type] ?? null;
    return null;
  };

  const isEditable = (element, role) => !element.readOnly && element.getAttribute('aria-readonly') !== 'true' &&
    (TEXT_ROLES.includes(role) || (role === 'combobox' && ['INPUT', 'TEXTAREA'].includes(element.tagName)));

  // ---- Freshness keys ----

  const viewportKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight];

  const formFieldsKey = () => queryAllDeep(FORM_FIELD_SELECTOR).filter(isObservableInput)
    .map(field => [nodeId(field), field.value, field.checked, field.selectedIndex, field.disabled, field.readOnly]);

  // ---- API used by browser.py and recorder.js ----

  state.closest = closestDeep;

  // Whether a click at (x, y) would land on element or one of its flat-tree descendants.
  state.hit = (element, x, y) => {
    for (let node = deepElementFromPoint(x, y); node; node = flatParent(node)) {
      if (node === element) return true;
    }
    return false;
  };

  state.describe = element => {
    const target = closestDeep(element, INTERACTIVE_SELECTOR);
    if (!target) return null;
    return {role: roleOf(target), label: accessibleName(target) || roleOf(target) || '', element: target};
  };

  state.pageKey = () => [...viewportKey(), formFieldsKey()];

  // What must still hold for an action on element to mean what it meant when observed.
  state.guard = element => {
    if (!element?.isConnected || !isVisible(element)) return null;
    const scope = closestDeep(element, GUARD_SCOPE_SELECTOR) || element.parentElement || element.getRootNode().host;
    return [
      nodeId(element), roleOf(element), accessibleName(element),
      element.value ?? null, element.checked ?? null, element.selectedIndex ?? null, element.readOnly ?? null,
      element.matches(':disabled'),
      element.getAttribute('aria-disabled'), element.getAttribute('aria-expanded'),
      element.getAttribute('aria-checked'), element.getAttribute('aria-selected'),
      element.getAttribute('href'),
      scope?.innerText?.slice(0, TEXT_LIMIT) || '',
    ];
  };

  // ---- Actions ----

  const centerOf = rect => ({x: rect.x + rect.width / 2, y: rect.y + rect.height / 2});

  // The element has a role and a nonempty box whose center is inside the viewport.
  const isActionable = (element, role, rect) => {
    const {x, y} = centerOf(rect);
    if (!role || rect.width <= 0 || rect.height <= 0) return false;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    // A grid cell that holds a button is acted on through the button.
    if (role === 'gridcell' && element.querySelector('button,[role="button"]')) return false;
    return true;
  };

  const baseAction = (element, role, rect) => {
    const base = {node: nodeId(element), role, label: accessibleName(element) || role,
      rect: {x: rect.x, y: rect.y, w: rect.width, h: rect.height}};
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = element.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(element.type)) base.checked = String(element.checked);
    return base;
  };

  // One action per option that could be chosen.
  const selectActions = (select, base) => {
    const currentValue = [...select.selectedOptions].map(option => option.label).join(', ');
    return [...select.options]
      .filter(option => !option.selected && !option.disabled && !option.closest('optgroup[disabled]'))
      .map(option => ({...base, kind: 'select', value: option.value,
        current_value: currentValue, label: base.label + ' → ' + option.label}));
  };

  // A fill for editable fields (plus a click to open them), otherwise a click.
  const otherActions = (element, role, base) => {
    const editable = isEditable(element, role);
    let value = '';
    if ('value' in element) value = String(element.value);
    else if (element.isContentEditable || role === 'combobox') value = element.innerText.trim();
    const actions = [{...base, kind: editable ? 'fill' : 'click', value}];
    if (editable) actions.push({...base, kind: 'click', value, label: 'Open ' + base.label});
    return actions;
  };

  const collectActions = () => {
    const actions = [];
    for (const element of queryAllDeep(INTERACTIVE_SELECTOR)) {
      if (!isObservableInput(element) || !isVisible(element) || isDisabled(element)) continue;
      const rect = element.getBoundingClientRect();
      const role = roleOf(element);
      if (!isActionable(element, role, rect)) continue;
      const base = baseAction(element, role, rect);
      if (element.tagName === 'SELECT') actions.push(...selectActions(element, base));
      else actions.push(...otherActions(element, role, base));
    }
    return actions;
  };

  // ---- Visible text ----

  const intersectsViewport = rect => rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;

  const visibleText = () => {
    const lines = [];
    const range = document.createRange();
    let length = 0;
    for (const node of walkDeep(document.body, NodeFilter.SHOW_TEXT)) {
      if (length >= TEXT_LIMIT) break;
      const value = node.textContent.trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest(NON_CONTENT_SELECTOR) || !isVisible(parent)) continue;
      range.selectNodeContents(node);
      if (!intersectsViewport(range.getBoundingClientRect())) continue;
      lines.push(value);
      length += value.length;
    }
    return lines.join('\n').slice(0, TEXT_LIMIT);
  };

  // ---- Snapshot ----

  const actions = collectActions();
  const text = visibleText();
  const height = document.documentElement.scrollHeight;
  const formFields = formFieldsKey();
  const page_key = [...viewportKey(), formFields];

  const guards = {};
  for (const action of actions) {
    if (!(action.node in guards)) guards[action.node] = state.guard(state.nodes.get(action.node));
  }

  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics = actions.map(({rect, ...action}) => action);
  const marker = [...viewportKey(), document.title, text, semantics, formFields];

  const omitted_actions = Math.max(0, actions.length - MAX_ACTIONS);
  actions.splice(MAX_ACTIONS);
  actions.forEach((action, index) => action.id = 'e' + (index + 1));
  if (scrollY + innerHeight < height - 2) {
    actions.push({id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: SCROLL_STEP});
  }
  if (scrollY > 0) actions.push({id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -SCROLL_STEP});
  actions.push({id: 'wait', kind: 'wait', label: 'Wait for the page to update'});

  return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: {y: scrollY, height}, actions, marker, page_key, guards, omitted_actions};
})()
