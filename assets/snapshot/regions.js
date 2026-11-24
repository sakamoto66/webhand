(view, C, dom, el) => {
  // Regions: main/form:予約/fieldset:追加プラン.
  const { walkDeep, queryAllDeep, flatParent } = dom;

  const regionKind = (element) => {
    const role = element.getAttribute("role");
    if (role) return C.REGION_ROLES[role] ?? null;
    const kind = C.REGION_TAGS[element.tagName] ?? null;
    if (kind === "section" && !element.hasAttribute("aria-label") && !element.hasAttribute("aria-labelledby")) {
      return null;
    }
    return kind;
  };

  const regionElements = new Map();
  for (const element of queryAllDeep(C.REGION_SELECTOR)) {
    const kind = regionKind(element);
    if (kind) regionElements.set(element, { kind });
  }

  const regionAncestor = (node) => {
    for (let current = node; current; current = flatParent(current)) {
      if (regionElements.has(current)) return current;
    }
    return null;
  };

  // Names come from labels and headings, never from field values. '/' separates segments, so it is dropped.
  const cleanName = (text) =>
    (text || "")
      .replace(/[\s/]+/g, " ")
      .trim()
      .slice(0, C.REGION_NAME_LIMIT)
      .trim();

  const firstText = (element) => {
    for (const node of walkDeep(element, NodeFilter.SHOW_TEXT)) {
      if (node.textContent.trim() && !node.parentElement?.closest(C.NON_CONTENT_SELECTOR)) return node;
    }
    return null;
  };

  const regionName = (element) => {
    const referenced = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => el.accessibleName(element.getRootNode().getElementById?.(id)))
      .filter(Boolean)
      .join(" ");
    if (referenced) return cleanName(referenced);
    const label = element.getAttribute("aria-label");
    if (label) return cleanName(label);
    const caption =
      element.tagName === "FIELDSET"
        ? element.querySelector(":scope > legend")
        : element.tagName === "TABLE"
          ? element.caption
          : null;
    if (caption?.textContent.trim()) return cleanName(caption.textContent);
    // A heading names the region only when it opens it, not when it titles a part further down.
    const heading = element.querySelector(C.HEADING_SELECTOR);
    if (heading && regionAncestor(heading) === element && heading.contains(firstText(element))) {
      return cleanName(heading.textContent);
    }
    return "";
  };

  const newRegion = (key, kind, element) => ({
    key,
    kind,
    element,
    text_chars: 0,
    shown_chars: 0,
    actions: 0,
    shown_actions: 0,
    offscreen_actions: 0,
  });

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
      if (group.length > 1) {
        group.forEach((info, index) => {
          info.ordinal = index + 1;
        });
      }
    }
  }
  const keyOf = (info) => {
    if (info.key) return info.key;
    const segment = info.name ? `${info.kind}:${info.name}` : info.kind + (info.ordinal ? `#${info.ordinal}` : "");
    info.key = (info.parent ? `${keyOf(info.parent)}/` : "") + segment;
    return info.key;
  };

  const regions = [];
  const pageRegion = newRegion("page", "page", null);
  const regionByElement = new Map();
  for (const [element, info] of regionElements) {
    const region = newRegion(keyOf(info), info.kind, element);
    regions.push(region);
    regionByElement.set(element, region);
  }
  const regionOf = (node) => regionByElement.get(regionAncestor(node)) ?? pageRegion;
  const actionRegions = new WeakMap();

  const segmentMatches = (pattern, segment) =>
    /[:#]/.test(pattern) ? pattern === segment : segment.split(/[:#]/)[0] === pattern;

  const matchDepth = (pattern, segments) => {
    const parts = String(pattern).split("/");
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
  const decide = (region) => {
    if (region.decision) return region.decision;
    const segments = region.key.split("/");
    let focus = { depth: -1, rank: 0 };
    focusPatterns.forEach((pattern, rank) => {
      const depth = matchDepth(pattern, segments);
      if (depth > focus.depth) focus = { depth, rank };
    });
    const skip = Math.max(-1, ...skipPatterns.map((pattern) => matchDepth(pattern, segments)));
    const inDialog = segments.some((segment) => segmentMatches("dialog", segment));
    let decision;
    if (skip > focus.depth) decision = { view: "skip", order: Infinity };
    else if (inDialog) decision = { view: focus.depth >= 0 ? "focus" : null, order: 0, whole: focus.depth >= 0 };
    else if (focus.depth >= 0) decision = { view: "focus", order: 1 + focus.rank, whole: true };
    else decision = { view: null, order: NORMAL_ORDER };
    region.decision = decision;
    return decision;
  };

  // With focus patterns, only focused regions (and open dialogs) are read; skipped regions never are.
  const readable = (element) => {
    const decision = decide(regionOf(element));
    if (decision.view === "skip") return false;
    return focusPatterns.length === 0 || decision.view === "focus" || decision.order === 0;
  };

  const positionOf = (region) => {
    if (!region.element) return "visible";
    const rect = region.element.getBoundingClientRect();
    if (rect.bottom <= 0) return "above";
    if (rect.top >= innerHeight) return "below";
    return "visible";
  };

  return { regions, pageRegion, regionOf, actionRegions, viewing, decide, readable, positionOf };
};
