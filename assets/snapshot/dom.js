() => {
  // Flat-tree traversal across open shadow roots. Closed roots are not reachable from page script.

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

  const queryAllDeep = (selector) =>
    [...walkDeep(document, NodeFilter.SHOW_ELEMENT)].filter((element) => element.matches(selector));

  // Like Element.closest, but continues from a shadow root to its host.
  const closestDeep = (element, selector) => {
    for (let current = element; current; current = current.getRootNode().host) {
      const found = current.closest(selector);
      if (found) return found;
    }
    return null;
  };

  // Slotted nodes belong to their slot, shadow roots to their host.
  // A shadow root's host, never an anchor's .host, which is a URL string.
  const flatParent = (node) =>
    node.assignedSlot || (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode);

  const flatChildren = (element) => {
    if (element.shadowRoot) return [...element.shadowRoot.childNodes];
    if (element.tagName === "SLOT" && element.assignedNodes().length) return element.assignedNodes({ flatten: true });
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

  return { walkDeep, queryAllDeep, closestDeep, flatParent, flatChildren, deepElementFromPoint };
};
