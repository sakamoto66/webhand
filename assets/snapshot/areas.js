(C, nodes, dom, el, lines, keptActions) => {
  const { state } = nodes;
  const { walkDeep, flatParent, flatChildren } = dom;

  const STAGE1_ROLES = {
    banner: "header",
    navigation: "nav",
    complementary: "aside",
    main: "main",
    contentinfo: "footer",
    dialog: "dialog",
    alertdialog: "alertdialog",
    alert: "alert",
    form: "form",
    table: "table",
    grid: "table",
    tablist: "tablist",
    tabpanel: "tabpanel",
    toolbar: "toolbar",
    search: "search",
    region: "section",
    article: "article",
  };
  const STAGE1_TAGS = {
    HEADER: "header",
    NAV: "nav",
    ASIDE: "aside",
    MAIN: "main",
    FOOTER: "footer",
    DIALOG: "dialog",
    FORM: "form",
    FIELDSET: "fieldset",
    TABLE: "table",
    SECTION: "section",
    ARTICLE: "article",
  };
  const NON_CONTAINER_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "PATH",
    "IMG",
    "BR",
    "HR",
    "SPAN",
    "A",
    "B",
    "I",
    "EM",
    "STRONG",
    "SMALL",
    "LABEL",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "BUTTON",
    "OPTION",
    "OPTGROUP",
    "CANVAS",
    "VIDEO",
    "AUDIO",
    "IFRAME",
  ]);
  const UTILITY_TOKEN_RE =
    /^(flex|grid|block|inline|inline-block|inline-flex|inline-grid|hidden|container|wrapper|inner|outer|box|row|col|relative|absolute|fixed|sticky|static|clearfix|sr-only|active|selected|focused|current|open|closed|disabled|visible|invisible|\d+)$/;
  const UTILITY_PREFIX_RE =
    /^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|bg|text|font|leading|tracking|border|rounded|shadow|gap|space|items|justify|content|self|place|col|row|z|top|left|right|bottom|inset|overflow|opacity|transition|duration|ease|cursor|select|pointer-events|css|sc|jsx|tw|sm|md|lg|xl|2xl|hover|focus|dark)[-_:]|^[a-f0-9]{6,}$|^_[a-zA-Z0-9]{4,}$/;
  const ERROR_TOKEN_RE =
    /(^|[\s_-])(error|err-msg|invalid-feedback|form-error|alert-danger|validation-error)($|[\s_-])/i;
  const TRANSIENT_CLASS_RE = /^(active|selected|current|focused|hover|open|odd|even|first|last|item-\d+)$/i;
  const ITEM_TAGS = new Set(["DIV", "LI", "ARTICLE", "SECTION", "A", "DD", "TR"]);
  const TABLE_SELECTOR = 'table,[role="table"],[role="grid"]';
  const CELL_SELECTOR = 'th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const FIELD_SKIP_SELECTOR = "script,style,noscript,template,input,textarea,select,option";

  const rectCache = new WeakMap();
  const getRect = (element) => {
    let rect = rectCache.get(element);
    if (!rect) {
      rect = element.getBoundingClientRect();
      rectCache.set(element, rect);
    }
    return rect;
  };

  const styleCache = new WeakMap();
  const getStyle = (element) => {
    let style = styleCache.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styleCache.set(element, style);
    }
    return style;
  };

  const hasBox = (rect) => rect.width > 0 && rect.height > 0;
  const docYOf = (rect) => Math.round(rect.top + scrollY);
  const positionOfRect = (rect) => (rect.bottom <= 0 ? "above" : rect.top >= innerHeight ? "below" : "visible");
  const whereOfRect = (rect) => (positionOfRect(rect) === "visible" ? "visible" : el.where(rect));
  const cleanName = (text) =>
    String(text || "")
      .replace(/[\s/]+/g, " ")
      .trim()
      .slice(0, C.AREA_NAME_LIMIT)
      .trim();

  // Single DOM-order pass to index all elements and collect visible pin triggers.
  const domIndex = new Map();
  let nextDomIndex = 0;
  let activeEl = document.activeElement;
  while (activeEl?.shadowRoot?.activeElement) activeEl = activeEl.shadowRoot.activeElement;
  if (!activeEl || activeEl === document.body || activeEl === document.documentElement || !el.isVisible(activeEl)) {
    activeEl = null;
  }

  const allElements = [];
  for (const element of walkDeep(document.body, NodeFilter.SHOW_ELEMENT)) {
    domIndex.set(element, nextDomIndex++);
    allElements.push(element);
  }

  const pinTriggers = [];
  const seenPinEl = new Set();
  const addPinTrigger = (element, reason, priority) => {
    if (!element || !el.isVisible(element)) return;
    if (seenPinEl.has(element)) return;
    seenPinEl.add(element);
    pinTriggers.push({ element, reason, priority });
  };

  for (const element of allElements) {
    if (NON_CONTAINER_TAGS.has(element.tagName) && element !== activeEl) {
      if (element.getAttribute("aria-invalid") === "true") addPinTrigger(element, "error", 4);
      continue;
    }
    const role = element.getAttribute("role");
    if (role === "alertdialog") addPinTrigger(element, "alertdialog", 1);
    else if (
      (element.tagName === "DIALOG" && element.open) ||
      role === "dialog" ||
      element.getAttribute("aria-modal") === "true"
    ) {
      addPinTrigger(element, "dialog", 2);
    } else if (role === "alert") {
      if ((element.textContent || "").trim()) addPinTrigger(element, "alert", 3);
    }
    if (element.getAttribute("aria-invalid") === "true") {
      addPinTrigger(element, "error", 4);
      const errIds = (element.getAttribute("aria-errormessage") || "").split(/\s+/).filter(Boolean);
      for (const id of errIds) {
        const ref = element.getRootNode().getElementById?.(id);
        if (ref) addPinTrigger(ref, "error", 4);
      }
    } else if (element.tagName !== "BODY" && element.tagName !== "HTML") {
      const idClass = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
      if (ERROR_TOKEN_RE.test(idClass)) {
        const textLen = (element.textContent || "").trim().length;
        const rect = getRect(element);
        if (textLen > 0 && textLen <= 400 && hasBox(rect) && rect.height < innerHeight * 0.6) {
          addPinTrigger(element, "error", 4);
        }
      }
    }
  }
  if (activeEl) addPinTrigger(activeEl, "active_element", 5);

  const idClassHint = (element) => {
    const raw = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    const tokens = [];
    for (const part of raw.split(/\s+/)) {
      const lower = part.toLowerCase().trim();
      if (!lower || lower.length < 2 || lower.length > 32) continue;
      if (UTILITY_TOKEN_RE.test(lower) || UTILITY_PREFIX_RE.test(lower)) continue;
      const clean = lower.replace(/[_-]+/g, " ").trim();
      if (clean && !tokens.includes(clean)) tokens.push(clean);
      if (tokens.length >= 2) break;
    }
    return cleanName(tokens.join(" "));
  };

  const firstVisibleTextNode = (element) => {
    for (const node of walkDeep(element, NodeFilter.SHOW_TEXT)) {
      const parent = node.parentElement;
      if (!parent || !node.textContent.trim()) continue;
      if (!parent.closest(C.NON_CONTENT_SELECTOR) && el.isVisible(parent)) return node;
    }
    return null;
  };

  const itemSignature = (element) => {
    const cls = typeof element.className === "string" ? element.className : "";
    const norm = cls
      .split(/\s+/)
      .filter((t) => t && !TRANSIENT_CLASS_RE.test(t))
      .sort()
      .join(".");
    return `${element.tagName}|${norm}|${element.getAttribute("role") || ""}`;
  };

  // Detect repeated sibling cards (e.g. >= 4 sibling <article>/<section>) so Stage 1 doesn't shatter card lists.
  const repeatedCardSet = new Set();
  for (const parent of allElements) {
    if (parent.childElementCount < 4) continue;
    const groups = new Map();
    for (const child of parent.children) {
      if (child.tagName !== "ARTICLE" && child.tagName !== "SECTION") continue;
      if (child.hasAttribute("aria-label") || child.hasAttribute("aria-labelledby")) continue;
      const sig = itemSignature(child);
      const list = groups.get(sig) ?? [];
      list.push(child);
      groups.set(sig, list);
    }
    for (const list of groups.values()) {
      if (list.length >= 4) {
        for (const item of list) repeatedCardSet.add(item);
      }
    }
  }

  const hasOwnVisibleHeading = (element, boundaryCheck) => {
    for (const heading of element.querySelectorAll(C.HEADING_SELECTOR)) {
      if (!el.isVisible(heading) || !(heading.textContent || "").trim()) continue;
      if (boundaryCheck && boundaryCheck(heading) !== element) continue;
      return heading;
    }
    return null;
  };

  // ---- Stage 1: HTML tags & ARIA landmarks ----
  const stage1Map = new Map();
  const stage1Kind = (element) => {
    const role = element.getAttribute("role");
    if (role && role in STAGE1_ROLES) {
      const kind = STAGE1_ROLES[role];
      if (kind === "section" || kind === "article") {
        if (repeatedCardSet.has(element)) return null;
        if (
          !element.hasAttribute("aria-label") &&
          !element.hasAttribute("aria-labelledby") &&
          !hasOwnVisibleHeading(element, null)
        ) {
          return null;
        }
      }
      return kind;
    }
    const tagKind = STAGE1_TAGS[element.tagName];
    if (!tagKind) return null;
    if (tagKind === "section" || tagKind === "article") {
      if (repeatedCardSet.has(element)) return null;
      if (
        !element.hasAttribute("aria-label") &&
        !element.hasAttribute("aria-labelledby") &&
        !hasOwnVisibleHeading(element, null)
      ) {
        return null;
      }
    }
    return tagKind;
  };

  for (const element of allElements) {
    if (element === document.body || element === document.documentElement) continue;
    const kind = stage1Kind(element);
    if (!kind) continue;
    if (!el.isVisible(element) || !hasBox(getRect(element))) continue;
    stage1Map.set(element, { element, kind, isStage2: false });
  }

  // ---- Stage 2: Geometry fallback for div-centric SPAs ----
  const stage2Map = new Map();
  const vw = innerWidth;
  const vh = innerHeight;
  const bodyRect = getRect(document.body);
  const bodyBottom = bodyRect.bottom + scrollY;
  const docHeight = Math.max(document.documentElement.scrollHeight, vh);
  const pageBottom = bodyBottom > 150 ? Math.min(docHeight, bodyBottom) : docHeight;
  const hasStage1Header = [...stage1Map.values()].some((entry) => entry.kind === "header");
  let hasStage2Header = false;
  const hasStage1Main = [...stage1Map.values()].some((entry) => entry.kind === "main");
  const hasStage1Footer = [...stage1Map.values()].some((entry) => entry.kind === "footer");
  let hasStage2Footer = false;

  const stage2Candidates = new Set();
  const queue = [];
  for (const child of document.body.children) {
    stage2Candidates.add(child);
    queue.push({ element: child, depth: 1 });
  }
  while (queue.length) {
    const { element, depth } = queue.shift();
    if (depth >= 5) continue;
    const visibleKids = [...element.children].filter((c) => !NON_CONTAINER_TAGS.has(c.tagName) && el.isVisible(c));
    const singleWrapper = visibleKids.length === 1;
    for (const child of visibleKids) {
      stage2Candidates.add(child);
      queue.push({ element: child, depth: singleWrapper ? depth : depth + 1 });
    }
  }

  const wrapsSingleLandmark = (element) => {
    const rect = getRect(element);
    const area = rect.width * rect.height;
    if (area <= 0) return false;
    for (const child of element.children) {
      if (!stage1Map.has(child) && !stage2Map.has(child)) continue;
      const cr = getRect(child);
      if (cr.width * cr.height >= area * 0.9) return true;
    }
    return false;
  };

  const hasHorizontalWiderSibling = (element, rect) => {
    const parent = element.parentElement;
    if (!parent) return null;
    for (const sib of parent.children) {
      if (sib === element || NON_CONTAINER_TAGS.has(sib.tagName) || !el.isVisible(sib)) continue;
      const sr = getRect(sib);
      if (!hasBox(sr)) continue;
      const verticalOverlap = Math.min(rect.bottom, sr.bottom) - Math.max(rect.top, sr.top);
      const horizontallyBeside = sr.left >= rect.right - 8 || rect.left >= sr.right - 8;
      if (verticalOverlap > 20 && horizontallyBeside && sr.width >= rect.width * 1.4) {
        return sib;
      }
    }
    return null;
  };

  const isRepeatedSibling = (element) => {
    if (repeatedCardSet.has(element)) return true;
    const parent = element.parentElement;
    if (!parent || parent.childElementCount < 3) return false;
    const sig = itemSignature(element);
    let count = 0;
    for (const sib of parent.children) {
      if (itemSignature(sib) === sig && ++count >= 3) return true;
    }
    return false;
  };

  const insideContentLandmark = (element) => {
    for (let cur = flatParent(element); cur; cur = flatParent(cur)) {
      const s1 = stage1Map.get(cur);
      if (s1 && ["main", "form", "table", "nav", "aside", "fieldset"].includes(s1.kind)) return true;
    }
    return false;
  };

  for (const element of stage2Candidates) {
    if (stage1Map.has(element) || stage2Map.has(element)) continue;
    if (NON_CONTAINER_TAGS.has(element.tagName) || !el.isVisible(element)) continue;
    if (isRepeatedSibling(element)) continue;
    const rect = getRect(element);
    if (rect.width < 80 || rect.height < 24) continue;
    if (wrapsSingleLandmark(element)) continue;

    const style = getStyle(element);
    const zIndex = Number.parseInt(style.zIndex, 10) || 0;
    const docTop = rect.top + scrollY;
    const docBottom = rect.bottom + scrollY;

    const isTopBar = rect.top <= 20 && rect.width >= vw * 0.65 && rect.height <= 140;
    const isBottomBar = rect.bottom >= vh - 20 && rect.width >= vw * 0.65 && rect.height <= 140;
    const inContent = insideContentLandmark(element);

    let kind = null;
    if (
      (style.position === "fixed" &&
        !isTopBar &&
        !isBottomBar &&
        (zIndex >= 10 || rect.width < vw * 0.85 || rect.height >= vh * 0.3)) ||
      (style.position === "absolute" && zIndex >= 50 && rect.width >= 120 && rect.height >= 40)
    ) {
      kind = "overlay";
    } else if (
      !inContent &&
      !hasStage1Header &&
      !hasStage2Header &&
      docTop <= 120 &&
      docTop < Math.max(200, pageBottom * 0.25) &&
      rect.width >= vw * 0.65 &&
      rect.height >= 24 &&
      rect.height <= Math.max(220, vh * 0.3) &&
      rect.height < pageBottom * 0.45
    ) {
      kind = "header";
      hasStage2Header = true;
    } else if (
      !inContent &&
      !hasStage1Footer &&
      !hasStage2Footer &&
      docBottom >= pageBottom - 160 &&
      docTop > Math.max(120, pageBottom * 0.45) &&
      rect.width >= vw * 0.65 &&
      rect.height >= 24 &&
      rect.height <= Math.max(360, pageBottom * 0.35)
    ) {
      kind = "footer";
      hasStage2Footer = true;
    } else if (!inContent && element.parentElement && rect.width >= 100 && rect.width <= vw * 0.38) {
      const parentStyle = getStyle(element.parentElement);
      const isRowFlex = parentStyle.display.includes("flex") && !parentStyle.flexDirection.startsWith("column");
      const isGrid = parentStyle.display.includes("grid");
      const nearEdge = rect.left <= vw * 0.18 || rect.right >= vw * 0.82;
      const parentRect = getRect(element.parentElement);
      if ((isRowFlex || isGrid) && nearEdge && rect.height >= Math.min(120, parentRect.height * 0.4)) {
        const widerSib = hasHorizontalWiderSibling(element, rect);
        if (widerSib) {
          kind = "sidebar";
          if (!hasStage1Main && !stage1Map.has(widerSib) && !stage2Map.has(widerSib)) {
            stage2Map.set(widerSib, { element: widerSib, kind: "main", isStage2: true });
          }
        }
      }
    }

    if (kind) stage2Map.set(element, { element, kind, isStage2: true });
  }

  // Merge Stage 1 and Stage 2 into landmark registry.
  const landmarkMap = new Map([...stage1Map, ...stage2Map]);

  const nearestLandmarkEl = (node) => {
    for (let cur = node; cur; cur = flatParent(cur)) {
      if (landmarkMap.has(cur)) return cur;
    }
    return null;
  };

  const computeName = (element, isStage2) => {
    const referenced = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => el.accessibleName(element.getRootNode().getElementById?.(id)))
      .filter(Boolean)
      .join(" ");
    if (referenced) return cleanName(referenced);
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return cleanName(ariaLabel);
    const caption =
      element.tagName === "FIELDSET"
        ? element.querySelector(":scope > legend")
        : element.tagName === "TABLE"
          ? element.caption
          : null;
    if (caption?.textContent.trim()) return cleanName(caption.textContent);
    const heading = element.querySelector(C.HEADING_SELECTOR);
    if (heading && el.isVisible(heading)) {
      const firstText = firstVisibleTextNode(element);
      const owner = nearestLandmarkEl(heading);
      if ((owner === element || !owner) && firstText && heading.contains(firstText)) {
        return cleanName(heading.textContent);
      }
      if ((owner === element || !owner) && ["DIALOG", "SECTION", "ARTICLE"].includes(element.tagName)) {
        return cleanName(heading.textContent);
      }
    }
    if (isStage2) return idClassHint(element);
    return "";
  };

  for (const entry of landmarkMap.values()) {
    entry.name = computeName(entry.element, entry.isStage2);
  }

  // Build ownership tree rooted at document.body.
  const rootNode = {
    element: document.body,
    kind: "page",
    name: "",
    isStage2: false,
    children: [],
    ownLines: [],
    ownActions: [],
    ownTriggers: [],
  };
  const treeNodes = new Map([[document.body, rootNode]]);
  for (const [element, info] of landmarkMap) {
    treeNodes.set(element, {
      ...info,
      children: [],
      ownLines: [],
      ownActions: [],
      ownTriggers: [],
    });
  }
  for (const [element, node] of treeNodes) {
    if (element === document.body) continue;
    const parentEl = nearestLandmarkEl(flatParent(element)) ?? document.body;
    const parentNode = treeNodes.get(parentEl) ?? rootNode;
    node.parent = parentNode;
    parentNode.children.push(node);
  }
  for (const node of treeNodes.values()) {
    node.children.sort((a, b) => (domIndex.get(a.element) ?? 0) - (domIndex.get(b.element) ?? 0));
  }

  // Map lines, keptActions, and pinTriggers to nearest landmark node.
  for (const line of lines) {
    const ownerEl = nearestLandmarkEl(line.parent) ?? document.body;
    (treeNodes.get(ownerEl) ?? rootNode).ownLines.push(line);
  }
  const keptDomActions = [];
  for (const action of keptActions) {
    if (!Number.isInteger(action.node)) continue;
    const element = state.nodes.get(action.node);
    if (!element) continue;
    keptDomActions.push({ action, element });
    const ownerEl = nearestLandmarkEl(element) ?? document.body;
    (treeNodes.get(ownerEl) ?? rootNode).ownActions.push({ action, element });
  }
  for (const trigger of pinTriggers) {
    const ownerEl = nearestLandmarkEl(trigger.element) ?? document.body;
    (treeNodes.get(ownerEl) ?? rootNode).ownTriggers.push(trigger);
  }

  // ---- Helpers for Stage 3 ----
  const countUniqueNodes = (actionEntries) => {
    const set = new Set();
    for (const entry of actionEntries) set.add(entry.action.node);
    return set.size;
  };

  const sumLineChars = (lineList) => {
    let total = 0;
    for (const l of lineList) total += l.value.length;
    return total;
  };

  const resolvePin = (scopeEl, scopeLines, scopeActions, scopeTriggers) => {
    let best = null;
    const consider = (trigger) => {
      if (!best || trigger.priority < best.priority) best = trigger;
    };
    for (const trigger of scopeTriggers) consider(trigger);
    for (const trigger of pinTriggers) {
      if (trigger.element === scopeEl) {
        consider(trigger);
        continue;
      }
      if (scopeActions.some(({ element }) => trigger.element === element || trigger.element.contains(element))) {
        consider(trigger);
        continue;
      }
      if (scopeLines.some((line) => trigger.element === line.parent || trigger.element.contains(line.parent))) {
        consider(trigger);
      }
    }
    return best ? { pinned: true, pin_reason: best.reason } : { pinned: false };
  };

  const extractTableColumns = (tableEl) => {
    const headerRows = [];
    const thead = tableEl.querySelector(":scope > thead");
    if (thead) {
      for (const tr of thead.querySelectorAll('tr,[role="row"]')) {
        if (el.isVisible(tr)) headerRows.push(tr);
      }
    }
    if (!headerRows.length) {
      for (const tr of tableEl.querySelectorAll('tr,[role="row"]')) {
        if (tr.closest(TABLE_SELECTOR) !== tableEl || !el.isVisible(tr)) continue;
        const hasTh = tr.querySelector('th,[role="columnheader"]');
        const hasTd = tr.querySelector('td,[role="cell"],[role="gridcell"]');
        if (hasTh && !hasTd) headerRows.push(tr);
        else break;
      }
    }
    if (!headerRows.length) return [];
    const lastHeader = headerRows[headerRows.length - 1];
    const cols = [];
    for (const cell of lastHeader.querySelectorAll(CELL_SELECTOR)) {
      if (cell.closest('tr,[role="row"]') !== lastHeader) continue;
      const text = cleanCellText(cell);
      if (text) cols.push(text);
    }
    return cols;
  };

  const cleanCellText = (cell) => {
    const parts = [];
    for (const node of walkDeep(cell, NodeFilter.SHOW_TEXT)) {
      const parent = node.parentElement;
      const val = node.textContent.replace(/\s+/g, " ").trim();
      if (!val || !parent || parent.closest(FIELD_SKIP_SELECTOR) || !el.isVisible(parent)) continue;
      parts.push(val);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  };

  const formatLinesText = (lineList) =>
    lineList
      .map((l) => l.value)
      .join("\n")
      .slice(0, C.AREA_TEXT_CAP);

  const computeRectForScope = (scopeEl, scopeLines, scopeActions) => {
    if (scopeEl && scopeEl !== document.body) {
      const r = getRect(scopeEl);
      if (hasBox(r)) return r;
    }
    for (const { element } of scopeActions) {
      const r = getRect(element);
      if (hasBox(r)) return r;
    }
    for (const line of scopeLines) {
      if (hasBox(line.rect)) return line.rect;
    }
    return new DOMRect(0, 0, vw, 0);
  };

  let groupSeq = 1;
  const nextGroupId = (prefix) => `${prefix}_${groupSeq++}`;

  const rawChunks = [];

  const emitChunk = ({
    element,
    landmarkRoot,
    kind,
    name,
    crumbs,
    linesList,
    actionEntries,
    triggerList,
    textOverride,
    columns,
    parent_group,
    slice,
  }) => {
    const pin = resolvePin(element, linesList, actionEntries, triggerList);
    if (!linesList.length && !actionEntries.length && !textOverride && !pin.pinned) return;
    const text = (textOverride !== undefined ? textOverride : formatLinesText(linesList)).slice(0, C.AREA_TEXT_CAP);
    const rect = computeRectForScope(element, linesList, actionEntries);
    rawChunks.push({
      element,
      landmarkRoot,
      kind,
      name,
      crumbs: crumbs.filter(Boolean),
      position: positionOfRect(rect),
      whereLabel: whereOfRect(rect),
      y: docYOf(rect),
      pinned: pin.pinned,
      ...(pin.pin_reason ? { pin_reason: pin.pin_reason } : {}),
      text,
      text_chars: text.length,
      actionEntries,
      ...(parent_group ? { parent_group } : {}),
      ...(columns?.length ? { columns } : {}),
      ...(slice ? { slice } : {}),
    });
  };

  const findRepeatedItemGroup = (rootEl, scopeLines, scopeActions) => {
    const scopeChars = sumLineChars(scopeLines);
    const scopeActionCount = scopeActions.length;
    const bfs = [{ el: rootEl, d: 0 }];
    let best = null;
    while (bfs.length) {
      const { el: parent, d } = bfs.shift();
      if (d > 5) continue;
      if (parent !== rootEl && parent.matches(TABLE_SELECTOR)) continue;
      if (parent.childElementCount >= 3) {
        const groups = new Map();
        for (const child of parent.children) {
          if (
            !ITEM_TAGS.has(child.tagName) &&
            !child.matches('[role="listitem"],[role="article"],[role="option"],[role="menuitem"]')
          ) {
            continue;
          }
          if (!el.isVisible(child) || !hasBox(getRect(child))) continue;
          const sig = itemSignature(child);
          const arr = groups.get(sig) ?? [];
          arr.push(child);
          groups.set(sig, arr);
        }
        for (const items of groups.values()) {
          if (items.length < 3) continue;
          const itemSet = new Set(items);
          let matchedChars = 0;
          let matchedActions = 0;
          for (const line of scopeLines) {
            if (items.some((it) => it === line.parent || it.contains(line.parent))) matchedChars += line.value.length;
          }
          for (const entry of scopeActions) {
            if (items.some((it) => it === entry.element || it.contains(entry.element))) matchedActions++;
          }
          const coversEnough =
            (scopeChars > 0 && matchedChars >= scopeChars * 0.4) ||
            (scopeActionCount > 0 && matchedActions >= scopeActionCount * 0.4);
          if (coversEnough && (!best || items.length > best.items.length)) {
            best = { parent, items, itemSet };
          }
        }
        if (best) return best;
      }
      for (const child of parent.children) {
        if (!NON_CONTAINER_TAGS.has(child.tagName) && el.isVisible(child)) {
          bfs.push({ el: child, d: d + 1 });
        }
      }
    }
    return null;
  };

  const splitBySubBoundaries = (rootEl, scopeLines, scopeActions, scopeTriggers) => {
    const boundarySelector =
      'form,fieldset,details,table,[role="table"],[role="grid"],[role="dialog"],[role="alertdialog"],[role="alert"],[role="tablist"],[role="tabpanel"],[role="toolbar"]';
    const candidates = [];
    for (const desc of rootEl.querySelectorAll(boundarySelector)) {
      if (desc === rootEl || !el.isVisible(desc) || !hasBox(getRect(desc))) continue;
      if (desc.tagName === "DETAILS" && !desc.open && !desc.querySelector("summary")) continue;
      candidates.push(desc);
    }
    if (!candidates.length) return null;
    const candidateSet = new Set(candidates);
    const topBoundaries = candidates.filter((cand) => {
      for (let p = flatParent(cand); p && p !== rootEl; p = flatParent(p)) {
        if (candidateSet.has(p)) return false;
      }
      return true;
    });
    if (!topBoundaries.length) return null;
    topBoundaries.sort((a, b) => (domIndex.get(a) ?? 0) - (domIndex.get(b) ?? 0));

    const buckets = new Map(topBoundaries.map((b) => [b, { element: b, lines: [], actions: [], triggers: [] }]));
    const residual = { lines: [], actions: [], triggers: [] };
    const findBucket = (node) => {
      for (let cur = node; cur && cur !== rootEl; cur = flatParent(cur)) {
        if (buckets.has(cur)) return buckets.get(cur);
      }
      return residual;
    };
    for (const line of scopeLines) findBucket(line.parent).lines.push(line);
    for (const entry of scopeActions) findBucket(entry.element).actions.push(entry);
    for (const trig of scopeTriggers) findBucket(trig.element).triggers.push(trig);

    const populated = [...buckets.values()].filter((b) => b.lines.length || b.actions.length);
    if (!populated.length) return null;
    if (populated.length === 1 && !residual.lines.length && !residual.actions.length) return null;

    // Partition residual into before/between/after boundary segments in DOM order.
    const segments = [];
    let currentRes = { isResidual: true, lines: [], actions: [], triggers: [] };
    const boundaryPositions = topBoundaries.map((b) => ({
      b,
      bucket: buckets.get(b),
      idx: domIndex.get(b) ?? 0,
    }));

    const flushRes = () => {
      if (currentRes.lines.length || currentRes.actions.length || currentRes.triggers.length) {
        segments.push(currentRes);
        currentRes = { isResidual: true, lines: [], actions: [], triggers: [] };
      }
    };

    const resItems = [
      ...residual.lines.map((l) => ({ type: "line", idx: domIndex.get(l.parent) ?? 0, item: l })),
      ...residual.actions.map((a) => ({ type: "action", idx: domIndex.get(a.element) ?? 0, item: a })),
      ...residual.triggers.map((t) => ({ type: "trigger", idx: domIndex.get(t.element) ?? 0, item: t })),
    ].sort((a, b) => a.idx - b.idx);

    let bi = 0;
    for (const entry of resItems) {
      while (bi < boundaryPositions.length && entry.idx >= boundaryPositions[bi].idx) {
        flushRes();
        const bp = boundaryPositions[bi++];
        if (bp.bucket.lines.length || bp.bucket.actions.length || bp.bucket.triggers.length) {
          segments.push({ isResidual: false, ...bp.bucket });
        }
      }
      if (entry.type === "line") currentRes.lines.push(entry.item);
      else if (entry.type === "action") currentRes.actions.push(entry.item);
      else currentRes.triggers.push(entry.item);
    }
    flushRes();
    while (bi < boundaryPositions.length) {
      const bp = boundaryPositions[bi++];
      if (bp.bucket.lines.length || bp.bucket.actions.length || bp.bucket.triggers.length) {
        segments.push({ isResidual: false, ...bp.bucket });
      }
    }
    return segments.length >= 2 ? segments : null;
  };

  const splitByHeadings = (rootEl, scopeLines, scopeActions, scopeTriggers, minHeadingLevel = 1) => {
    const repeatedItemInfo = findRepeatedItemGroup(rootEl, scopeLines, scopeActions);
    const lineIdxMin = scopeLines.length ? Math.min(...scopeLines.map((l) => domIndex.get(l.parent) ?? 0)) : Infinity;
    const actIdxMin = scopeActions.length
      ? Math.min(...scopeActions.map((a) => domIndex.get(a.element) ?? 0))
      : Infinity;
    const minIdx = Math.min(lineIdxMin, actIdxMin);
    const lineIdxMax = scopeLines.length ? Math.max(...scopeLines.map((l) => domIndex.get(l.parent) ?? 0)) : -1;
    const actIdxMax = scopeActions.length ? Math.max(...scopeActions.map((a) => domIndex.get(a.element) ?? 0)) : -1;
    const maxIdx = Math.max(lineIdxMax, actIdxMax);

    const headings = [];
    for (const h of rootEl.querySelectorAll(C.HEADING_SELECTOR)) {
      if (!el.isVisible(h) || !(h.textContent || "").trim()) continue;
      const tbl = h.closest(TABLE_SELECTOR);
      if (tbl && tbl !== rootEl && rootEl.contains(tbl)) continue;
      if (repeatedItemInfo?.items.some((it) => it.contains(h))) continue;
      const idx = domIndex.get(h) ?? 0;
      if (idx < minIdx || idx > maxIdx) continue;
      const level = /^H([1-6])$/.test(h.tagName)
        ? Number.parseInt(h.tagName.slice(1), 10)
        : Number.parseInt(h.getAttribute("aria-level") || "2", 10) || 2;
      if (level < minHeadingLevel) continue;
      headings.push({ el: h, level, idx, title: cleanName(h.textContent) });
    }
    if (!headings.length) return null;

    const levels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b);
    for (const lvl of levels) {
      const chosen = headings.filter((h) => h.level === lvl).sort((a, b) => a.idx - b.idx);
      if (!chosen.length) continue;
      const sections = [{ heading: null, level: lvl, lines: [], actions: [], triggers: [] }];
      for (const h of chosen) sections.push({ heading: h, level: lvl, lines: [], actions: [], triggers: [] });

      const slotForIdx = (idx) => {
        let s = 0;
        for (let i = 0; i < chosen.length; i++) {
          if (idx >= chosen[i].idx) s = i + 1;
          else break;
        }
        return s;
      };
      for (const line of scopeLines) sections[slotForIdx(domIndex.get(line.parent) ?? 0)].lines.push(line);
      for (const entry of scopeActions) sections[slotForIdx(domIndex.get(entry.element) ?? 0)].actions.push(entry);
      for (const trig of scopeTriggers) sections[slotForIdx(domIndex.get(trig.element) ?? 0)].triggers.push(trig);

      const nonEmpty = sections.filter((s) => s.lines.length || s.actions.length);
      if (nonEmpty.length >= 2) return nonEmpty;
    }
    return null;
  };

  const splitTableRows = (tableEl, kind, name, crumbs, landmarkRoot, scopeLines, scopeActions, scopeTriggers) => {
    const columns = extractTableColumns(tableEl);
    const headerRowSet = new Set();
    const thead = tableEl.querySelector(":scope > thead");
    if (thead) {
      for (const tr of thead.querySelectorAll('tr,[role="row"]')) headerRowSet.add(tr);
    }
    const allRows = [...tableEl.querySelectorAll('tr,[role="row"]')].filter(
      (tr) => tr.closest(TABLE_SELECTOR) === tableEl && el.isVisible(tr),
    );
    const dataRows = [];
    for (const tr of allRows) {
      if (headerRowSet.has(tr)) continue;
      const hasTh = tr.querySelector('th,[role="columnheader"]');
      const hasTd = tr.querySelector('td,[role="cell"],[role="gridcell"]');
      if (hasTh && !hasTd && !dataRows.length) {
        headerRowSet.add(tr);
        continue;
      }
      dataRows.push(tr);
    }
    if (dataRows.length < 2) return false;

    const rowMap = new Map(dataRows.map((tr) => [tr, { tr, lines: [], actions: [], triggers: [] }]));
    const findRow = (node) => {
      const tr = node.closest?.('tr,[role="row"]');
      return tr && rowMap.has(tr) ? rowMap.get(tr) : null;
    };
    for (const line of scopeLines) findRow(line.parent)?.lines.push(line);
    for (const entry of scopeActions) findRow(entry.element)?.actions.push(entry);
    for (const trig of scopeTriggers) findRow(trig.element)?.triggers.push(trig);

    const rowEntries = [...rowMap.values()].filter((r) => r.lines.length || r.actions.length);
    if (rowEntries.length < 2) return false;

    const rowText = (tr) => {
      const cells = [...tr.querySelectorAll(CELL_SELECTOR)].filter((c) => c.closest('tr,[role="row"]') === tr);
      if (!cells.length) return cleanCellText(tr);
      return cells.map(cleanCellText).join(" | ");
    };

    const headerLine = columns.length ? columns.join(" | ") : "";
    const slices = [];
    let cur = { rows: [], lines: [], actions: [], triggers: [], chars: headerLine.length, nodeSet: new Set() };
    const pushSlice = () => {
      if (cur.rows.length) slices.push(cur);
      cur = { rows: [], lines: [], actions: [], triggers: [], chars: headerLine.length, nodeSet: new Set() };
    };

    for (const row of rowEntries) {
      const rText = rowText(row.tr);
      const rChars = rText.length + 1;
      let newNodes = 0;
      for (const a of row.actions) {
        if (!cur.nodeSet.has(a.action.node)) newNodes++;
      }
      if (
        cur.rows.length > 0 &&
        (cur.chars + rChars > C.AREA_TARGET_CHARS || cur.nodeSet.size + newNodes > C.AREA_TARGET_ACTIONS)
      ) {
        pushSlice();
      }
      cur.rows.push(rText);
      cur.lines.push(...row.lines);
      cur.actions.push(...row.actions);
      cur.triggers.push(...row.triggers);
      cur.chars += rChars;
      for (const a of row.actions) cur.nodeSet.add(a.action.node);
    }
    pushSlice();

    const groupId = nextGroupId("tbl");
    const total = slices.length;
    slices.forEach((sl, idx) => {
      const bodyText = sl.rows.join("\n");
      const text = headerLine ? `${headerLine}\n${bodyText}` : bodyText;
      emitChunk({
        element: tableEl,
        landmarkRoot,
        kind,
        name,
        crumbs,
        linesList: sl.lines,
        actionEntries: sl.actions,
        triggerList: sl.triggers,
        textOverride: text,
        columns,
        parent_group: groupId,
        slice: { index: idx + 1, total },
      });
    });
    return true;
  };

  const packSegmentsAsSlices = (segments, { element, landmarkRoot, kind, name, crumbs, groupPrefix, depth }) => {
    const slices = [];
    let cur = { items: [], lines: [], actions: [], triggers: [], chars: 0, nodeSet: new Set(), pinned: false };
    const flush = () => {
      if (cur.lines.length || cur.actions.length || cur.triggers.length) slices.push(cur);
      cur = { items: [], lines: [], actions: [], triggers: [], chars: 0, nodeSet: new Set(), pinned: false };
    };

    for (const seg of segments) {
      const segChars = sumLineChars(seg.lines);
      const segPin = resolvePin(seg.element, seg.lines, seg.actions, seg.triggers);
      let newNodes = 0;
      for (const a of seg.actions) {
        if (!cur.nodeSet.has(a.action.node)) newNodes++;
      }
      const wouldExceed =
        cur.items.length > 0 &&
        (cur.chars + segChars > C.AREA_TARGET_CHARS || cur.nodeSet.size + newNodes > C.AREA_TARGET_ACTIONS);
      if (wouldExceed || (cur.items.length > 0 && (segPin.pinned || cur.pinned))) {
        flush();
      }
      if (segChars > C.AREA_TARGET_CHARS || countUniqueNodes(seg.actions) > C.AREA_TARGET_ACTIONS) {
        flush();
        if (depth < 8 && seg.element && seg.element.children.length > 0) {
          splitScope({
            element: seg.element,
            landmarkRoot,
            kind,
            name,
            crumbs,
            scopeLines: seg.lines,
            scopeActions: seg.actions,
            scopeTriggers: seg.triggers,
            depth: depth + 1,
          });
          continue;
        }
      }
      cur.items.push(seg);
      cur.lines.push(...seg.lines);
      cur.actions.push(...seg.actions);
      cur.triggers.push(...seg.triggers);
      cur.chars += segChars;
      if (segPin.pinned) cur.pinned = true;
      for (const a of seg.actions) cur.nodeSet.add(a.action.node);
    }
    flush();

    if (!slices.length) return;
    const groupId = slices.length > 1 ? nextGroupId(groupPrefix) : undefined;
    const total = slices.length;
    slices.forEach((sl, idx) => {
      const anchor = sl.items[0]?.element ?? element;
      emitChunk({
        element: anchor,
        landmarkRoot,
        kind,
        name,
        crumbs,
        linesList: sl.lines,
        actionEntries: sl.actions,
        triggerList: sl.triggers,
        ...(groupId ? { parent_group: groupId, slice: { index: idx + 1, total } } : {}),
      });
    });
  };

  const splitScope = ({
    element,
    landmarkRoot,
    kind,
    name,
    crumbs,
    scopeLines,
    scopeActions,
    scopeTriggers,
    depth,
    minHeadingLevel = 1,
  }) => {
    const textChars = sumLineChars(scopeLines);
    const uniqueNodes = countUniqueNodes(scopeActions);
    const isTable = element?.matches?.(TABLE_SELECTOR);
    const columns = isTable ? extractTableColumns(element) : undefined;

    if ((textChars <= C.AREA_TARGET_CHARS && uniqueNodes <= C.AREA_TARGET_ACTIONS) || depth >= 8) {
      emitChunk({
        element,
        landmarkRoot,
        kind,
        name,
        crumbs,
        linesList: scopeLines,
        actionEntries: scopeActions,
        triggerList: scopeTriggers,
        columns,
      });
      return;
    }

    // (1) Child landmarks / form / fieldset / details
    if (element) {
      const subSegments = splitBySubBoundaries(element, scopeLines, scopeActions, scopeTriggers);
      if (subSegments) {
        for (const seg of subSegments) {
          if (seg.isResidual) {
            splitScope({
              element,
              landmarkRoot,
              kind,
              name,
              crumbs,
              scopeLines: seg.lines,
              scopeActions: seg.actions,
              scopeTriggers: seg.triggers,
              depth: depth + 1,
              minHeadingLevel,
            });
          } else {
            const subKind =
              STAGE1_ROLES[seg.element.getAttribute("role")] ??
              STAGE1_TAGS[seg.element.tagName] ??
              seg.element.tagName.toLowerCase();
            const subName = computeName(seg.element, false);
            const segLabel = subName ? `${subKind}:${subName}` : subKind;
            splitScope({
              element: seg.element,
              landmarkRoot: seg.element,
              kind: subKind,
              name: subName,
              crumbs: [...crumbs, segLabel],
              scopeLines: seg.lines,
              scopeActions: seg.actions,
              scopeTriggers: seg.triggers,
              depth: depth + 1,
            });
          }
        }
        return;
      }
    }

    // (2) Heading sections (h1-h6 / role=heading)
    if (element) {
      const headingSections = splitByHeadings(element, scopeLines, scopeActions, scopeTriggers, minHeadingLevel);
      if (headingSections) {
        for (const sec of headingSections) {
          const secName = sec.heading?.title || name;
          const secKind = sec.heading ? "section" : kind;
          const secCrumbs = sec.heading?.title ? [...crumbs, `section:${sec.heading.title}`] : crumbs;
          splitScope({
            element,
            landmarkRoot,
            kind: secKind,
            name: secName,
            crumbs: secCrumbs,
            scopeLines: sec.lines,
            scopeActions: sec.actions,
            scopeTriggers: sec.triggers,
            depth: depth + 1,
            minHeadingLevel: sec.level + 1,
          });
        }
        return;
      }
    }

    // (3) Table row slicing + thead/th column header inheritance
    const tableEl = isTable
      ? element
      : element &&
        [...element.querySelectorAll(TABLE_SELECTOR)].find(
          (t) =>
            el.isVisible(t) &&
            (scopeLines.some((l) => t === l.parent || t.contains(l.parent)) ||
              scopeActions.some((a) => t === a.element || t.contains(a.element))),
        );
    if (tableEl && el.isVisible(tableEl)) {
      if (
        splitTableRows(
          tableEl,
          "table",
          tableEl === element ? name : computeName(tableEl, false) || name,
          tableEl === element ? crumbs : [...crumbs, "table"],
          tableEl === element ? landmarkRoot : tableEl,
          scopeLines,
          scopeActions,
          scopeTriggers,
        )
      ) {
        return;
      }
    }

    // (4) ITEMS-equivalent repeated cards / list groups
    if (element) {
      const repeated = findRepeatedItemGroup(element, scopeLines, scopeActions);
      if (repeated) {
        const before = { lines: [], actions: [], triggers: [] };
        const after = { lines: [], actions: [], triggers: [] };
        const firstIdx = domIndex.get(repeated.items[0]) ?? 0;
        const lastIdx = domIndex.get(repeated.items[repeated.items.length - 1]) ?? 0;
        const itemMap = new Map(
          repeated.items.map((it) => [it, { element: it, lines: [], actions: [], triggers: [] }]),
        );
        const findItem = (node) => {
          for (let cur = node; cur && cur !== repeated.parent; cur = flatParent(cur)) {
            if (itemMap.has(cur)) return itemMap.get(cur);
          }
          return null;
        };
        for (const line of scopeLines) {
          const bucket = findItem(line.parent);
          if (bucket) bucket.lines.push(line);
          else if ((domIndex.get(line.parent) ?? 0) < firstIdx) before.lines.push(line);
          else if ((domIndex.get(line.parent) ?? 0) > lastIdx) after.lines.push(line);
          else before.lines.push(line);
        }
        for (const entry of scopeActions) {
          const bucket = findItem(entry.element);
          if (bucket) bucket.actions.push(entry);
          else if ((domIndex.get(entry.element) ?? 0) < firstIdx) before.actions.push(entry);
          else after.actions.push(entry);
        }
        for (const trig of scopeTriggers) {
          const bucket = findItem(trig.element);
          if (bucket) bucket.triggers.push(trig);
          else if ((domIndex.get(trig.element) ?? 0) < firstIdx) before.triggers.push(trig);
          else after.triggers.push(trig);
        }

        if (before.lines.length || before.actions.length) {
          splitScope({
            element,
            landmarkRoot,
            kind,
            name,
            crumbs,
            scopeLines: before.lines,
            scopeActions: before.actions,
            scopeTriggers: before.triggers,
            depth: depth + 1,
          });
        }
        const itemSegs = [...itemMap.values()].filter(
          (it) => it.lines.length || it.actions.length || it.triggers.length,
        );
        packSegmentsAsSlices(itemSegs, {
          element: repeated.parent,
          landmarkRoot,
          kind,
          name,
          crumbs,
          groupPrefix: "list",
          depth: depth + 1,
        });
        if (after.lines.length || after.actions.length) {
          splitScope({
            element,
            landmarkRoot,
            kind,
            name,
            crumbs,
            scopeLines: after.lines,
            scopeActions: after.actions,
            scopeTriggers: after.triggers,
            depth: depth + 1,
          });
        }
        return;
      }
    }

    // (5) Direct block children packing
    if (element) {
      let blockRoot = element;
      let visibleChildren = flatChildren(blockRoot).filter(
        (c) => c.nodeType === Node.ELEMENT_NODE && !NON_CONTAINER_TAGS.has(c.tagName) && el.isVisible(c),
      );
      while (visibleChildren.length === 1 && flatChildren(visibleChildren[0]).length > 0) {
        blockRoot = visibleChildren[0];
        visibleChildren = flatChildren(blockRoot).filter(
          (c) => c.nodeType === Node.ELEMENT_NODE && !NON_CONTAINER_TAGS.has(c.tagName) && el.isVisible(c),
        );
      }
      if (visibleChildren.length >= 2) {
        const childMap = new Map(visibleChildren.map((c) => [c, { element: c, lines: [], actions: [], triggers: [] }]));
        const loose = { element: blockRoot, lines: [], actions: [], triggers: [] };
        const findChildBucket = (node) => {
          for (let cur = node; cur && cur !== blockRoot; cur = flatParent(cur)) {
            if (childMap.has(cur)) return childMap.get(cur);
          }
          return loose;
        };
        for (const line of scopeLines) findChildBucket(line.parent).lines.push(line);
        for (const entry of scopeActions) findChildBucket(entry.element).actions.push(entry);
        for (const trig of scopeTriggers) findChildBucket(trig.element).triggers.push(trig);

        const segs = [...childMap.values()].filter((s) => s.lines.length || s.actions.length || s.triggers.length);
        if (loose.lines.length || loose.actions.length) segs.unshift(loose);
        if (segs.length >= 2) {
          packSegmentsAsSlices(segs, {
            element: blockRoot,
            landmarkRoot,
            kind,
            name,
            crumbs,
            groupPrefix: "blk",
            depth: depth + 1,
          });
          return;
        }
      }
    }

    emitChunk({
      element,
      landmarkRoot,
      kind,
      name,
      crumbs,
      linesList: scopeLines,
      actionEntries: scopeActions,
      triggerList: scopeTriggers,
      columns,
    });
  };

  // Traverse ownership tree in DOM order.
  const visitNode = (node, parentCrumbs) => {
    const segLabel = node.name ? `${node.kind}:${node.name}` : node.kind;
    const crumbs = node === rootNode ? [] : [...parentCrumbs, segLabel];

    if (!node.children.length) {
      if (node.ownLines.length || node.ownActions.length || node.ownTriggers.length) {
        splitScope({
          element: node.element,
          landmarkRoot: node.element,
          kind: node.kind,
          name: node.name,
          crumbs: crumbs.length ? crumbs : ["page"],
          scopeLines: node.ownLines,
          scopeActions: node.ownActions,
          scopeTriggers: node.ownTriggers,
          depth: 0,
        });
      }
      return;
    }

    // Keep small unified forms whole when they have no pinned fieldset children.
    if (node.kind === "form") {
      const allLines = [...node.ownLines];
      const allActions = [...node.ownActions];
      const allTriggers = [...node.ownTriggers];
      const stack = [...node.children];
      let hasNonFieldsetChild = false;
      let hasPinnedChild = false;
      while (stack.length) {
        const ch = stack.pop();
        if (ch.kind !== "fieldset") hasNonFieldsetChild = true;
        if (resolvePin(ch.element, ch.ownLines, ch.ownActions, ch.ownTriggers).pinned) hasPinnedChild = true;
        allLines.push(...ch.ownLines);
        allActions.push(...ch.ownActions);
        allTriggers.push(...ch.ownTriggers);
        stack.push(...ch.children);
      }
      if (
        !hasNonFieldsetChild &&
        !hasPinnedChild &&
        sumLineChars(allLines) <= C.AREA_TARGET_CHARS &&
        countUniqueNodes(allActions) <= C.AREA_TARGET_ACTIONS
      ) {
        splitScope({
          element: node.element,
          landmarkRoot: node.element,
          kind: node.kind,
          name: node.name,
          crumbs,
          scopeLines: allLines,
          scopeActions: allActions,
          scopeTriggers: allTriggers,
          depth: 0,
        });
        return;
      }
    }

    // Interleave node's residual lines/actions with child landmarks in DOM order.
    const childEntries = node.children.map((child) => ({
      child,
      idx: domIndex.get(child.element) ?? 0,
    }));
    const resItems = [
      ...node.ownLines.map((l) => ({ type: "line", idx: domIndex.get(l.parent) ?? 0, item: l })),
      ...node.ownActions.map((a) => ({ type: "action", idx: domIndex.get(a.element) ?? 0, item: a })),
      ...node.ownTriggers.map((t) => ({ type: "trigger", idx: domIndex.get(t.element) ?? 0, item: t })),
    ].sort((a, b) => a.idx - b.idx);

    let resBuf = { lines: [], actions: [], triggers: [] };
    const flushResBuf = () => {
      if (!resBuf.lines.length && !resBuf.actions.length && !resBuf.triggers.length) return;
      splitScope({
        element: node.element,
        landmarkRoot: node.element,
        kind: node.kind,
        name: node.name,
        crumbs: crumbs.length ? crumbs : ["page"],
        scopeLines: resBuf.lines,
        scopeActions: resBuf.actions,
        scopeTriggers: resBuf.triggers,
        depth: 0,
      });
      resBuf = { lines: [], actions: [], triggers: [] };
    };

    let ci = 0;
    for (const entry of resItems) {
      while (ci < childEntries.length && entry.idx >= childEntries[ci].idx) {
        flushResBuf();
        visitNode(childEntries[ci++].child, crumbs);
      }
      if (entry.type === "line") resBuf.lines.push(entry.item);
      else if (entry.type === "action") resBuf.actions.push(entry.item);
      else resBuf.triggers.push(entry.item);
    }
    flushResBuf();
    while (ci < childEntries.length) {
      visitNode(childEntries[ci++].child, crumbs);
    }
  };

  visitNode(rootNode, []);

  // ---- Stage 4: Merge adjacent tiny areas (never mix pinned, never cross landmarks) ----
  const isTiny = (chunk) =>
    chunk.text_chars < C.AREA_MIN_CHARS && countUniqueNodes(chunk.actionEntries) <= C.AREA_MIN_ACTIONS;

  const merged = [];
  for (const curr of rawChunks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      (isTiny(prev) || isTiny(curr)) &&
      !prev.pinned &&
      !curr.pinned &&
      prev.landmarkRoot === curr.landmarkRoot &&
      prev.kind === curr.kind &&
      prev.parent_group === curr.parent_group &&
      prev.position === curr.position
    ) {
      const combinedNodes = new Set([
        ...prev.actionEntries.map((a) => a.action.node),
        ...curr.actionEntries.map((a) => a.action.node),
      ]);
      const combinedText = [prev.text, curr.text].filter(Boolean).join("\n").slice(0, C.AREA_TEXT_CAP);
      if (combinedText.length <= C.AREA_TARGET_CHARS && combinedNodes.size <= C.AREA_TARGET_ACTIONS) {
        prev.text = combinedText;
        prev.text_chars = combinedText.length;
        prev.actionEntries = [...prev.actionEntries, ...curr.actionEntries];
        if (!prev.name && curr.name) prev.name = curr.name;
        continue;
      }
    }
    merged.push(curr);
  }

  // Recompute slice totals for any parent_group affected by merging.
  const byGroup = new Map();
  for (const chunk of merged) {
    if (chunk.parent_group) {
      const arr = byGroup.get(chunk.parent_group) ?? [];
      arr.push(chunk);
      byGroup.set(chunk.parent_group, arr);
    }
  }
  for (const groupChunks of byGroup.values()) {
    if (groupChunks.length === 1) {
      delete groupChunks[0].slice;
      delete groupChunks[0].parent_group;
    } else {
      groupChunks.forEach((c, idx) => {
        c.slice = { index: idx + 1, total: groupChunks.length };
      });
    }
  }

  // Assign final IDs, link action.area, build action_preview & breadcrumb.
  const areas = merged.map((chunk, idx) => {
    const id = `a${idx + 1}`;
    const actionNodes = [];
    const seenNodeIds = new Set();
    const preview = [];
    for (const { action } of chunk.actionEntries) {
      action.area = id;
      if (!seenNodeIds.has(action.node)) {
        seenNodeIds.add(action.node);
        actionNodes.push(action.node);
        if (preview.length < C.AREA_PREVIEW_LIMIT) {
          preview.push(`${action.role} "${el.squash(action.label, 40)}"`);
        }
      }
    }

    const dedupCrumbs = [];
    for (const seg of chunk.crumbs) {
      if (seg && seg !== dedupCrumbs[dedupCrumbs.length - 1]) dedupCrumbs.push(seg);
    }
    const parts = [dedupCrumbs.join(" > ") || chunk.kind];
    if (chunk.slice) parts.push(`[slice ${chunk.slice.index}/${chunk.slice.total}]`);
    if (chunk.columns?.length) {
      const colText = chunk.columns.slice(0, 6).join(", ") + (chunk.columns.length > 6 ? ", ..." : "");
      parts.push(`[cols: ${colText}]`);
    }
    parts.push(`@ ${chunk.whereLabel}`);

    return {
      id,
      kind: chunk.kind,
      name: chunk.name,
      breadcrumb: parts.join(" "),
      position: chunk.position,
      y: chunk.y,
      pinned: chunk.pinned,
      ...(chunk.pin_reason ? { pin_reason: chunk.pin_reason } : {}),
      text: chunk.text,
      text_chars: chunk.text_chars,
      action_nodes: actionNodes,
      action_count: chunk.actionEntries.length,
      action_preview: preview,
      ...(chunk.parent_group ? { parent_group: chunk.parent_group } : {}),
      ...(chunk.columns?.length ? { columns: chunk.columns } : {}),
      ...(chunk.slice ? { slice: chunk.slice } : {}),
    };
  });

  // Safety net: ensure every kept DOM action has an area assigned.
  const orphans = keptDomActions.filter(({ action }) => !action.area);
  if (orphans.length) {
    const id = `a${areas.length + 1}`;
    const actionNodes = [];
    const seen = new Set();
    const preview = [];
    for (const { action } of orphans) {
      action.area = id;
      if (!seen.has(action.node)) {
        seen.add(action.node);
        actionNodes.push(action.node);
        if (preview.length < C.AREA_PREVIEW_LIMIT) {
          preview.push(`${action.role} "${el.squash(action.label, 40)}"`);
        }
      }
    }
    const firstRect = getRect(orphans[0].element);
    areas.push({
      id,
      kind: "page",
      name: "",
      breadcrumb: `page @ ${whereOfRect(firstRect)}`,
      position: positionOfRect(firstRect),
      y: docYOf(firstRect),
      pinned: false,
      text: "",
      text_chars: 0,
      action_nodes: actionNodes,
      action_count: orphans.length,
      action_preview: preview,
    });
  }

  return areas;
};
