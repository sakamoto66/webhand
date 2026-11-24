(C, dom) => {
  const { closestDeep, flatParent, flatChildren } = dom;

  const squash = (text, limit) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);

  // Where content is, rounded to 100px: the direction to scroll and how far.
  const where = (rect) => {
    if (rect.bottom <= 0) return `above ${Math.max(100, Math.round(-rect.bottom / 100) * 100)}px`;
    if (rect.top >= innerHeight) return `below ${Math.max(100, Math.round((rect.top - innerHeight) / 100) * 100)}px`;
    return "in view";
  };

  const isObservableInput = (element) => !C.UNOBSERVED_INPUT_TYPES.includes(element.type);
  const isFileInput = (element) => element.tagName === "INPUT" && element.type === "file";
  const isToggleInput = (element) => element.tagName === "INPUT" && ["checkbox", "radio"].includes(element.type);

  const boxOf = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };

  const isVisible = (element) =>
    !closestDeep(element, C.HIDDEN_SELECTOR) &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  const isDisabled = (element) => element.matches(":disabled") || closestDeep(element, '[aria-disabled="true"]');

  const labelBoxOf = (element) => {
    for (const label of element.labels || []) {
      if (isVisible(label)) {
        const rect = boxOf(label);
        if (rect) return rect;
      }
    }
    return null;
  };

  const isToggleWithVisibleLabel = (element) =>
    isToggleInput(element) && !closestDeep(element, C.HIDDEN_SELECTOR) && Boolean(labelBoxOf(element));

  const codeEditorBox = (element) => {
    if (element.tagName !== "TEXTAREA" || closestDeep(element, C.HIDDEN_SELECTOR)) return null;
    const editor = closestDeep(element, C.CODE_EDITOR_SELECTOR);
    if (!editor || !isVisible(editor)) return null;
    const surface = editor.querySelector(C.CODE_EDITOR_SURFACE_SELECTOR);
    return (surface && isVisible(surface) && boxOf(surface)) || boxOf(editor);
  };

  const isCodeEditorInput = (element) => Boolean(codeEditorBox(element));

  // A simplified accessible name computation. `seen` stops reference cycles.
  const accessibleName = (element, seen = new Set()) => {
    if (!element || seen.has(element)) return "";
    seen.add(element);
    const nameOf = (node) => accessibleName(node, seen);

    const referenced = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => nameOf(element.getRootNode().getElementById?.(id)))
      .filter(Boolean)
      .join(" ");
    if (referenced) return referenced;

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    const labels = [...(element.labels || [])].map(nameOf).filter(Boolean).join(" ");
    if (labels) return labels;

    if (C.BUTTON_INPUT_TYPES.includes(element.type) && element.value) return element.value;

    const alt = element.getAttribute("alt");
    if (alt) return alt;

    if (!["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) {
      const content = flatChildren(element)
        .map((child) => {
          if (child.nodeType === Node.TEXT_NODE) return child.textContent;
          if (child.nodeType === Node.ELEMENT_NODE && child.getAttribute("aria-hidden") !== "true")
            return nameOf(child);
          return "";
        })
        .join(" ")
        .trim();
      if (content) return content;
    }

    return element.getAttribute("title") || element.getAttribute("placeholder") || "";
  };

  // A hidden file input is offered only through a visible label or single nearby trigger.
  const fileTrigger = (input) => {
    for (const label of input.labels || []) {
      if (isVisible(label) && boxOf(label)) {
        return { rect: boxOf(label), label: accessibleName(input) || accessibleName(label) };
      }
    }
    const scope = input.parentElement;
    if (!scope || !isVisible(scope)) return null;
    const near = [...scope.querySelectorAll('button,[role="button"],a[href],label')].filter(
      (item) => item !== input && !item.contains(input) && isVisible(item) && boxOf(item),
    );
    return near.length === 1 ? { rect: boxOf(near[0]), label: accessibleName(near[0]) || accessibleName(input) } : null;
  };

  const TAG_ROLES = { BUTTON: "button", SUMMARY: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox" };
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (C.INTERACTIVE_ROLES.includes(explicit)) return explicit;
    if (element.tagName in TAG_ROLES) return TAG_ROLES[element.tagName];
    if (element.isContentEditable) return "textbox";
    if (element.tagName === "INPUT") return C.INPUT_ROLES[element.type] ?? null;
    return null;
  };

  const cursorOf = (node) => (node instanceof Element ? getComputedStyle(node).cursor : null);
  const isClickable = (element) => {
    if (C.NOT_CLICKABLE_TAGS.includes(element.tagName) || element.matches(C.INTERACTIVE_SELECTOR)) return false;
    const signal =
      element.hasAttribute("onclick") ||
      (element.hasAttribute("tabindex") && element.tabIndex >= 0) ||
      (cursorOf(element) === "pointer" && cursorOf(flatParent(element)) !== "pointer");
    if (!signal) return false;
    const parent = flatParent(element);
    if (parent instanceof Element && closestDeep(parent, C.INTERACTIVE_SELECTOR)) return false;
    if (element.querySelector(C.INTERACTIVE_SELECTOR) || element.shadowRoot?.querySelector(C.INTERACTIVE_SELECTOR)) {
      return false;
    }
    return Boolean(accessibleName(element));
  };

  // The role an action on element is observed with, or null when it is not acted on.
  const targetRole = (element) =>
    element.matches(C.INTERACTIVE_SELECTOR) ? roleOf(element) : isClickable(element) ? "clickable" : null;

  const isEditable = (element, role) =>
    !element.readOnly &&
    element.getAttribute("aria-readonly") !== "true" &&
    (C.TEXT_ROLES.includes(role) || (role === "combobox" && ["INPUT", "TEXTAREA"].includes(element.tagName)));

  return {
    squash,
    where,
    isObservableInput,
    isFileInput,
    isToggleInput,
    boxOf,
    labelBoxOf,
    isToggleWithVisibleLabel,
    codeEditorBox,
    isCodeEditorInput,
    fileTrigger,
    isVisible,
    isDisabled,
    accessibleName,
    roleOf,
    isClickable,
    targetRole,
    isEditable,
  };
};
