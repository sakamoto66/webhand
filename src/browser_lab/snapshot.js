// view = {focus: [...], skip: [...]}: region patterns Claude chose from what was learned. Empty: DOM order.
(view => {
  if (!document.body) return null;

  // ---- Limits and vocabularies ----

  const TEXT_LIMIT = 6000;
  const MAX_ACTIONS = 250;
  const SCROLL_STEP = 560;
  const MAX_REGIONS = 40;
  const REGION_NAME_LIMIT = 40;

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
  // Regions the page is divided into. An explicit role decides the kind before the tag does.
  const REGION_ROLES = {
    dialog: 'dialog', alertdialog: 'dialog', banner: 'header', navigation: 'nav', main: 'main',
    complementary: 'aside', contentinfo: 'footer', search: 'search', form: 'form', grid: 'table',
    listbox: 'listbox', menu: 'menu', region: 'section',
  };
  const REGION_TAGS = {DIALOG: 'dialog', HEADER: 'header', NAV: 'nav', MAIN: 'main', ASIDE: 'aside',
    FOOTER: 'footer', FORM: 'form', FIELDSET: 'fieldset', TABLE: 'table', SECTION: 'section'};
  const REGION_SELECTOR = [...Object.keys(REGION_TAGS).map(tag => tag.toLowerCase()),
    ...Object.keys(REGION_ROLES).map(role => '[role="' + role + '"]')].join(',');
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

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

  const centerInViewport = rect => {
    const {x, y} = centerOf(rect);
    return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  };

  // The element has a role and a nonempty box. Its center must also be inside the viewport to be acted on.
  const isTarget = (element, role, rect) => {
    if (!role || rect.width <= 0 || rect.height <= 0) return false;
    // A grid cell that holds a button is acted on through the button.
    return !(role === 'gridcell' && element.querySelector('button,[role="button"]'));
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

  // In DOM order. Each action's region is kept aside so the freshness marker does not depend on it.
  const collectActions = () => {
    const actions = [];
    for (const element of queryAllDeep(INTERACTIVE_SELECTOR)) {
      if (!isObservableInput(element) || !isVisible(element) || isDisabled(element)) continue;
      const rect = element.getBoundingClientRect();
      const role = roleOf(element);
      if (!isTarget(element, role, rect)) continue;
      const region = regionOf(element);
      if (!centerInViewport(rect)) {
        region.offscreen_actions++;
        continue;
      }
      const base = baseAction(element, role, rect);
      const found = element.tagName === 'SELECT' ? selectActions(element, base) : otherActions(element, role, base);
      for (const action of found) actionRegions.set(action, region);
      region.actions += found.length;
      actions.push(...found);
    }
    return actions;
  };

  // ---- Regions ----
  // A key names a region by the regions around it: main/form:予約/fieldset:追加プラン. A segment is
  // kind:name, or kind#n among unnamed siblings of one kind, or the kind alone when it has no such sibling.

  const regionKind = element => {
    const role = element.getAttribute('role');
    if (role) return REGION_ROLES[role] ?? null;
    const kind = REGION_TAGS[element.tagName] ?? null;
    if (kind === 'section' && !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) return null;
    return kind;
  };

  const regionElements = new Map();
  for (const element of queryAllDeep(REGION_SELECTOR)) {
    const kind = regionKind(element);
    if (kind) regionElements.set(element, {kind});
  }

  const regionAncestor = node => {
    for (let current = node; current; current = flatParent(current)) {
      if (regionElements.has(current)) return current;
    }
    return null;
  };

  // Names come from labels and headings, never from field values. '/' separates segments, so it is dropped.
  const cleanName = text => (text || '').replace(/[\s/]+/g, ' ').trim().slice(0, REGION_NAME_LIMIT).trim();

  const regionName = element => {
    const referenced = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => accessibleName(element.getRootNode().getElementById?.(id))).filter(Boolean).join(' ');
    if (referenced) return cleanName(referenced);
    const label = element.getAttribute('aria-label');
    if (label) return cleanName(label);
    const caption = element.tagName === 'FIELDSET' ? element.querySelector(':scope > legend') :
      element.tagName === 'TABLE' ? element.caption : null;
    if (caption?.textContent.trim()) return cleanName(caption.textContent);
    // A heading names the region only when it opens it, not when it titles a part further down.
    const heading = element.querySelector(HEADING_SELECTOR);
    if (heading && regionAncestor(heading) === element && heading.contains(firstText(element))) {
      return cleanName(heading.textContent);
    }
    return '';
  };

  const firstText = element => {
    for (const node of walkDeep(element, NodeFilter.SHOW_TEXT)) {
      if (node.textContent.trim() && !node.parentElement?.closest(NON_CONTENT_SELECTOR)) return node;
    }
    return null;
  };

  const newRegion = (key, kind, element) => ({key, kind, element, text_chars: 0, shown_chars: 0,
    actions: 0, shown_actions: 0, offscreen_actions: 0});

  for (const [element, info] of regionElements) {
    info.name = regionName(element);
    info.parent = regionElements.get(regionAncestor(flatParent(element))) ?? null;
  }
  const unnamed = new Map();
  for (const info of regionElements.values()) {
    if (info.name) continue;
    const siblings = unnamed.get(info.parent) ?? {};
    siblings[info.kind] = [...(siblings[info.kind] ?? []), info];
    unnamed.set(info.parent, siblings);
  }
  for (const siblings of unnamed.values()) {
    for (const group of Object.values(siblings)) {
      if (group.length > 1) group.forEach((info, index) => info.ordinal = index + 1);
    }
  }
  const keyOf = info => {
    if (info.key) return info.key;
    const segment = info.name ? info.kind + ':' + info.name : info.kind + (info.ordinal ? '#' + info.ordinal : '');
    return info.key = (info.parent ? keyOf(info.parent) + '/' : '') + segment;
  };
  const regions = [];
  const pageRegion = newRegion('page', 'page', null);
  const regionByElement = new Map();
  for (const [element, info] of regionElements) {
    const region = newRegion(keyOf(info), info.kind, element);
    regions.push(region);
    regionByElement.set(element, region);
  }
  const regionOf = node => regionByElement.get(regionAncestor(node)) ?? pageRegion;
  const actionRegions = new WeakMap();

  // A pattern matches a run of segments anywhere in a key, so it covers the region and everything in it.
  // A pattern segment with a name or number must be equal; a bare kind matches any segment of that kind.
  const segmentMatches = (pattern, segment) =>
    /[:#]/.test(pattern) ? pattern === segment : segment.split(/[:#]/)[0] === pattern;

  const matchDepth = (pattern, segments) => {
    const parts = String(pattern).split('/');
    let depth = -1;
    for (let start = 0; start + parts.length <= segments.length; start++) {
      if (parts.every((part, i) => segmentMatches(part, segments[start + i]))) depth = start + parts.length - 1;
    }
    return depth;
  };

  const focusPatterns = Array.isArray(view?.focus) ? view.focus : [];
  const skipPatterns = Array.isArray(view?.skip) ? view.skip : [];
  const viewing = focusPatterns.length > 0 || skipPatterns.length > 0;
  const NORMAL_ORDER = 1e6;

  // The deepest match wins, focus on a tie. Open dialogs come first unless skipped.
  const decide = region => {
    if (region.decision) return region.decision;
    const segments = region.key.split('/');
    let focus = {depth: -1, rank: 0};
    focusPatterns.forEach((pattern, rank) => {
      const depth = matchDepth(pattern, segments);
      if (depth > focus.depth) focus = {depth, rank};
    });
    const skip = Math.max(-1, ...skipPatterns.map(pattern => matchDepth(pattern, segments)));
    const inDialog = segments.some(segment => segmentMatches('dialog', segment));
    let decision;
    if (skip > focus.depth) decision = {view: 'skip', order: Infinity};
    else if (inDialog) decision = {view: focus.depth >= 0 ? 'focus' : null, order: 0, whole: focus.depth >= 0};
    else if (focus.depth >= 0) decision = {view: 'focus', order: 1 + focus.rank, whole: true};
    else decision = {view: null, order: NORMAL_ORDER};
    return region.decision = decision;
  };

  const positionOf = region => {
    if (!region.element) return 'visible';
    const rect = region.element.getBoundingClientRect();
    if (rect.bottom <= 0) return 'above';
    if (rect.top >= innerHeight) return 'below';
    return 'visible';
  };

  // ---- Text ----

  const intersectsViewport = rect => rect.width > 0 && rect.height > 0 &&
    rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;

  // Every visible text node on the page, with its region and whether it is in the viewport.
  const textLines = () => {
    const lines = [];
    const range = document.createRange();
    const visibleParents = new Map();
    for (const node of walkDeep(document.body, NodeFilter.SHOW_TEXT)) {
      const value = node.textContent.trim();
      const parent = node.parentElement;
      if (!value || !parent) continue;
      if (!visibleParents.has(parent)) {
        visibleParents.set(parent, !parent.closest(NON_CONTENT_SELECTOR) && isVisible(parent));
      }
      if (!visibleParents.get(parent)) continue;
      range.selectNodeContents(node);
      const region = regionOf(parent);
      region.text_chars += value.length;
      lines.push({value, region, inView: intersectsViewport(range.getBoundingClientRect())});
    }
    return lines;
  };

  // Lines are taken until the limit is reached, then joined and cut. Returns the text and each line's share.
  const fitText = lines => {
    const taken = [];
    let length = 0;
    for (const line of lines) {
      if (length >= TEXT_LIMIT) break;
      taken.push(line);
      length += line.value.length;
    }
    let position = 0;
    for (const line of taken) {
      line.shown = Math.max(0, Math.min(line.value.length, TEXT_LIMIT - position));
      position += line.value.length + 1;
    }
    return {text: taken.map(line => line.value).join('\n').slice(0, TEXT_LIMIT), taken};
  };

  // Without a view: the viewport in DOM order, exactly as before. With one: grouped by region in view order,
  // focused regions from the whole page, the rest from the viewport, skipped regions left out.
  const viewText = lines => {
    const groups = new Map();
    for (const line of lines) {
      const decision = decide(line.region);
      if (decision.view === 'skip' || (!decision.whole && !line.inView)) continue;
      if (!groups.has(line.region)) groups.set(line.region, []);
      groups.get(line.region).push(line);
    }
    const ordered = [...groups].sort(([a], [b]) => decide(a).order - decide(b).order);
    return fitText(ordered.flatMap(([region, regionLines]) => [{value: '## ' + region.key}, ...regionLines]));
  };

  // ---- Snapshot ----

  const actions = collectActions();
  const lines = textLines();
  // The freshness marker always uses the viewport text in DOM order, whatever the view.
  const base = fitText(lines.filter(line => line.inView));
  const text = base.text;
  const shown = viewing ? viewText(lines) : base;
  for (const line of shown.taken) if (line.region) line.region.shown_chars += line.shown;
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

  let chosen = actions;
  if (viewing) {
    chosen = actions.filter(action => decide(actionRegions.get(action)).view !== 'skip')
      .map((action, index) => ({action, index}))
      .sort((a, b) => decide(actionRegions.get(a.action)).order - decide(actionRegions.get(b.action)).order ||
        a.index - b.index)
      .map(({action}) => action);
  }
  chosen = chosen.slice(0, MAX_ACTIONS);
  const omitted_actions = actions.length - chosen.length;
  for (const action of chosen) actionRegions.get(action).shown_actions++;
  chosen.forEach((action, index) => action.id = 'e' + (index + 1));
  if (scrollY + innerHeight < height - 2) {
    chosen.push({id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: SCROLL_STEP});
  }
  if (scrollY > 0) chosen.push({id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -SCROLL_STEP});
  chosen.push({id: 'wait', kind: 'wait', label: 'Wait for the page to update'});

  // The page's outline: every region with content, how much of it is shown, and where it is.
  const outline = [pageRegion, ...regions]
    .filter(region => region.text_chars || region.actions || region.offscreen_actions)
    .filter(region => !region.element || isVisible(region.element));
  const regionSummary = outline.slice(0, MAX_REGIONS).map(region => {
    const summary = {key: region.key, position: positionOf(region), text_chars: region.text_chars,
      shown_chars: region.shown_chars, actions: region.actions, shown_actions: region.shown_actions,
      offscreen_actions: region.offscreen_actions};
    if (viewing && decide(region).view) summary.view = decide(region).view;
    return summary;
  });

  state.region = element => regionOf(element).key;

  return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, text: shown.text,
    scroll: {y: scrollY, height}, actions: chosen, marker, page_key, guards, omitted_actions,
    regions: regionSummary, omitted_regions: outline.length - regionSummary.length};
})
