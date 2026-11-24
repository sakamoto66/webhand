(view, C, nodes, dom, el, reg, readKinds) => {
  const { state, nodeId } = nodes;
  const { walkDeep, closestDeep, flatParent } = dom;
  const { regionOf, actionRegions, readable } = reg;

  const centerOf = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const centerInViewport = (rect) => {
    const { x, y } = centerOf(rect);
    return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  };

  // The element has a role and a nonempty box.
  const isTarget = (element, role, rect) => {
    if (!role || rect.width <= 0 || rect.height <= 0) return false;
    // A grid cell that holds a button is acted on through the button.
    return !(role === "gridcell" && element.querySelector('button,[role="button"]'));
  };

  // What a read-only session needs to refuse: non-GET form submits, or buttons outside forms.
  const changeOf = (element, role) => {
    const form = element.form || null;
    if (form && element.matches(C.SUBMIT_SELECTOR)) {
      const method = String(element.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
      return method === "get" ? null : "form";
    }
    if (role === "button" && !element.matches("summary,a[href]")) return "control";
    return null;
  };

  const baseAction = (element, role, rect) => {
    const base = {
      node: nodeId(element),
      role,
      label: el.accessibleName(element) || role,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
    for (const key of ["checked", "selected", "expanded"]) {
      const value = element.getAttribute(`aria-${key}`);
      if (value !== null) base[key] = value;
    }
    if (["checkbox", "radio"].includes(element.type)) base.checked = String(element.checked);
    const change = changeOf(element, role);
    if (change) base.change = change;
    return base;
  };

  // One action per option that could be chosen (or deselected in a multi-select).
  const selectActions = (select, base) => {
    const currentValue = [...select.selectedOptions].map((option) => option.label).join(", ");
    return [...select.options]
      .filter(
        (option) => (!option.selected || select.multiple) && !option.disabled && !option.closest("optgroup[disabled]"),
      )
      .map((option) => ({
        ...base,
        kind: "select",
        value: option.value,
        ...(select.multiple && option.selected ? { deselect: true } : {}),
        current_value: currentValue,
        label: `${base.label} → ${select.multiple && option.selected ? "deselect " : ""}${option.label}`,
      }));
  };

  const hasHiddenSubmenu = (element) => {
    const container =
      element.closest('li,[role="menuitem"],[role="treeitem"]') ||
      (closestDeep(element, 'nav,aside,header,[role="navigation"],[role="menubar"],[role="menu"]')
        ? element.parentElement
        : null);
    if (!container || C.SUBMENU_LANDMARKS.has(container.tagName)) return false;
    const primary = container.querySelector(C.INTERACTIVE_SELECTOR);
    if (primary && primary !== element) return false;
    return [...container.querySelectorAll(C.SUBMENU_SELECTOR)].some(
      (menu) => !el.isVisible(menu) && menu.querySelector(C.SUBMENU_ITEM_SELECTOR),
    );
  };

  const isHoverTrigger = (element, role) =>
    ["link", "button", "menuitem", "tab", "clickable"].includes(role) &&
    (element.hasAttribute("onmouseenter") ||
      element.hasAttribute("onmouseover") ||
      element.getAttribute("aria-haspopup") === "menu" ||
      element.getAttribute("aria-haspopup") === "true" ||
      hasHiddenSubmenu(element));

  // A fill for editable fields (plus a click to open them), otherwise a click (plus hover on submenu triggers).
  const otherActions = (element, role, base) => {
    if (el.isFileInput(element)) return [{ ...base, kind: "upload" }];
    const editable = el.isEditable(element, role);
    let value = "";
    if ("value" in element) value = String(element.value);
    // biome-ignore lint/performance/useDomNodeTextContent: rendered text (excludes hidden CSS) is required for editable/combobox values.
    else if (element.isContentEditable || role === "combobox") value = element.innerText.trim();
    const actions = [{ ...base, kind: editable ? "fill" : "click", value }];
    if (editable) actions.push({ ...base, kind: "click", value, label: `Open ${base.label}` });
    else if (isHoverTrigger(element, role)) actions.push({ ...base, kind: "hover", value: "" });
    return actions;
  };

  const resolveElementBox = (element, file) => {
    if (el.isVisible(element)) return { rect: element.getBoundingClientRect(), hidden: null };
    if (file) {
      const hidden = el.fileTrigger(element);
      return hidden ? { rect: hidden.rect, hidden } : null;
    }
    if (el.isToggleInput(element) && !closestDeep(element, C.HIDDEN_SELECTOR)) {
      return { rect: el.labelBoxOf(element), hidden: null };
    }
    if (element.tagName === "TEXTAREA") return { rect: el.codeEditorBox(element), hidden: null };
    return null;
  };

  const reveals = [];
  const revealed = new Set();
  const whole = Boolean(view.whole);
  const beyond = [];

  const collectActions = () => {
    const actions = [];
    for (const element of walkDeep(document, NodeFilter.SHOW_ELEMENT)) {
      const role = el.targetRole(element);
      const file = el.isFileInput(element);
      if (!role || !(el.isObservableInput(element) || file) || el.isDisabled(element)) continue;
      const box = resolveElementBox(element, file);
      if (!box?.rect || !isTarget(element, role, box.rect)) continue;
      const { rect, hidden } = box;
      const region = regionOf(element);
      if (!centerInViewport(rect)) {
        region.offscreen_actions++;
        if (whole) {
          const base = baseAction(element, role, rect);
          const found = element.tagName === "SELECT" ? selectActions(element, base) : otherActions(element, role, base);
          const at = el.where(rect);
          const distance = rect.bottom <= 0 ? -rect.bottom : rect.top - innerHeight;
          for (const action of found) {
            action.at = at;
            action.offscreen = true;
            actionRegions.set(action, region);
            beyond.push({ action, distance });
          }
          continue;
        }
        if (readKinds.length && readable(element) && !revealed.has(element)) {
          revealed.add(element);
          reveals.push({
            node: nodeId(element),
            role,
            label: `Scroll to ${el.accessibleName(element) || role}`,
            kind: "reveal",
            at: el.where(rect),
          });
        }
        continue;
      }
      const base = baseAction(element, role, rect);
      if (hidden) Object.assign(base, { hidden: true, label: hidden.label || role });
      const found = element.tagName === "SELECT" ? selectActions(element, base) : otherActions(element, role, base);
      for (const action of found) actionRegions.set(action, region);
      region.actions += found.length;
      actions.push(...found);
    }
    return actions;
  };

  const CONTEXT_STOP_TAGS = new Set([
    "HTML",
    "BODY",
    "MAIN",
    "ASIDE",
    "NAV",
    "HEADER",
    "FOOTER",
    "DIALOG",
    "TABLE",
    "TBODY",
    "THEAD",
  ]);
  const CONTEXT_SKIP_SELECTOR = "script,style,noscript,template,input,textarea,select,option";
  const CONTEXT_MAX_CHARS = 60;

  // Visible text inside `root` excluding `skipEl` and form controls (never reads field or password values).
  const contextText = (root, skipEl) => {
    const parts = [];
    for (const node of walkDeep(root, NodeFilter.SHOW_TEXT)) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent || skipEl.contains(parent) || parent.closest(CONTEXT_SKIP_SELECTOR) || !el.isVisible(parent))
        continue;
      parts.push(text);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, CONTEXT_MAX_CHARS);
  };

  // When two or more distinct elements share (role, label), attach disambiguating context from each unique container.
  const attachDuplicateContexts = (allActions) => {
    const groups = new Map();
    for (const action of allActions) {
      if (!action.node || action.kind === "select") continue;
      const key =
        `${action.role}|` +
        (action.kind === "click" && String(action.label).startsWith("Open ") ? action.label.slice(5) : action.label);
      let map = groups.get(key);
      if (!map) {
        map = new Map();
        groups.set(key, map);
      }
      const list = map.get(action.node) ?? [];
      list.push(action);
      map.set(action.node, list);
    }
    for (const nodeMap of groups.values()) {
      if (nodeMap.size < 2) continue;
      const elements = [...nodeMap.keys()].map((id) => state.nodes.get(id)).filter(Boolean);
      if (elements.length < 2) continue;
      const contexts = new Map();
      for (const id of nodeMap.keys()) {
        const element = state.nodes.get(id);
        if (!element) continue;
        const others = elements.filter((other) => other !== element);
        let container = null;
        for (
          let cur = flatParent(element), depth = 0;
          cur instanceof Element && depth < 5;
          cur = flatParent(cur), depth++
        ) {
          if (CONTEXT_STOP_TAGS.has(cur.tagName)) break;
          if (others.some((other) => cur.contains(other))) break;
          container = cur;
        }
        if (!container) continue;
        const heading = container.querySelector('label,legend,h1,h2,h3,h4,h5,h6,[role="heading"]');
        let ctx = heading && !element.contains(heading) && el.isVisible(heading) ? contextText(heading, element) : "";
        if (!ctx) ctx = contextText(container, element);
        if (ctx) contexts.set(id, ctx);
      }
      if (new Set(contexts.values()).size < 2) continue;
      for (const [id, ctx] of contexts) {
        for (const action of nodeMap.get(id) ?? []) action.context = ctx;
      }
    }
  };

  // Each <select> expands to one action per option; count it once against the cap so a long dropdown cannot evict siblings.
  const takeCapped = (items, limit, getAction) => {
    const out = [];
    const seenSelects = new Set();
    let slots = 0;
    for (const item of items) {
      const action = getAction(item);
      if (action.kind === "select") {
        if (!seenSelects.has(action.node)) {
          if (slots >= limit) break;
          seenSelects.add(action.node);
          slots++;
        }
        out.push(item);
      } else {
        if (slots >= limit) break;
        slots++;
        out.push(item);
      }
    }
    return out;
  };

  return { collectActions, attachDuplicateContexts, takeCapped, reveals, beyond };
};
