(C, nodes, dom, el) => {
  const { state, nodeId } = nodes;
  const { queryAllDeep, closestDeep, flatParent, deepElementFromPoint } = dom;

  const viewportKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight];

  const fieldValue = (field) =>
    field.tagName === "SELECT" && field.multiple
      ? [...field.selectedOptions].map((option) => option.value).join("\0")
      : (field.value ?? null);

  const formFieldsKey = () =>
    queryAllDeep(C.FORM_FIELD_SELECTOR)
      .filter(el.isObservableInput)
      .map((field) => [
        nodeId(field),
        fieldValue(field),
        field.checked,
        field.selectedIndex,
        field.disabled,
        field.readOnly,
      ]);

  // API used by src/browser/ and assets/recorder.js.
  state.closest = closestDeep;
  state.top = deepElementFromPoint;

  // Whether a click at (x, y) would land on element, one of its flat-tree descendants, or its own label.
  state.hit = (element, x, y) => {
    for (let node = deepElementFromPoint(x, y); node; node = flatParent(node)) {
      if (node === element || (node.tagName === "LABEL" && node.control === element)) return true;
    }
    return false;
  };

  // What lies over (x, y) instead of the element: the nearest dialog, or fixed or sticky layer.
  state.cover = (x, y) => {
    const top = deepElementFromPoint(x, y);
    let layer = null;
    for (let node = top; node instanceof Element; node = flatParent(node)) {
      const position = getComputedStyle(node).position;
      if (
        node.tagName === "DIALOG" ||
        ["dialog", "alertdialog"].includes(node.getAttribute("role")) ||
        node.getAttribute("aria-modal") === "true" ||
        position === "fixed" ||
        position === "sticky"
      ) {
        layer = node;
        break;
      }
    }
    const shown = layer || top;
    if (!shown) return "something";
    const role = shown.getAttribute("role") || (shown.tagName === "DIALOG" ? "dialog" : shown.tagName.toLowerCase());
    const heading = shown.querySelector?.('h1,h2,h3,h4,[role="heading"],legend');
    const name = (shown.getAttribute("aria-label") || heading?.textContent || shown.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    const modal =
      layer &&
      (layer.tagName === "DIALOG" ||
        ["dialog", "alertdialog"].includes(layer.getAttribute("role")) ||
        layer.getAttribute("aria-modal") === "true");
    const kind = modal ? "a dialog" : layer ? `a fixed ${role}` : `a ${role}`;
    return name ? `${kind} "${name}"` : kind;
  };

  state.describe = (element) => {
    let target = closestDeep(element, C.INTERACTIVE_SELECTOR);
    for (let current = element; !target && current instanceof Element; current = flatParent(current)) {
      if (el.isClickable(current)) target = current;
    }
    if (!target) return null;
    const role = el.targetRole(target);
    return { role, label: el.accessibleName(target) || role || "", element: target };
  };

  state.pageKey = () => [...viewportKey(), formFieldsKey()];

  // What must still hold for an action on element to mean what it meant when observed.
  state.guard = (element) => {
    if (
      !element?.isConnected ||
      !(
        el.isVisible(element) ||
        el.isFileInput(element) ||
        el.isToggleWithVisibleLabel(element) ||
        el.isCodeEditorInput(element)
      )
    ) {
      return null;
    }
    const scope = closestDeep(element, C.GUARD_SCOPE_SELECTOR) || element.parentElement || element.getRootNode().host;
    return [
      nodeId(element),
      el.targetRole(element),
      el.accessibleName(element),
      fieldValue(element),
      element.checked ?? null,
      element.selectedIndex ?? null,
      element.readOnly ?? null,
      element.matches(":disabled"),
      element.getAttribute("aria-disabled"),
      element.getAttribute("aria-expanded"),
      element.getAttribute("aria-checked"),
      element.getAttribute("aria-selected"),
      element.getAttribute("href"),
      // biome-ignore lint/performance/useDomNodeTextContent: guard compares rendered text of the surrounding scope.
      scope?.innerText?.slice(0, C.TEXT_LIMIT) || "",
      // Whether the scope is a list item or row (its text says which item the target belongs to).
      scope?.matches?.('article,li,tr,[role="row"]') ? "item" : "other",
    ];
  };

  return { viewportKey, formFieldsKey };
};
