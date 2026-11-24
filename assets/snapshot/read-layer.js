(view, C, dom, el, reg) => {
  const { walkDeep, queryAllDeep, closestDeep } = dom;
  const { isVisible, accessibleName, roleOf, where, squash } = el;
  const { regionOf, decide, readable } = reg;

  const intersectsViewport = (rect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < innerHeight &&
    rect.right > 0 &&
    rect.left < innerWidth;

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
        visibleParents.set(parent, !parent.closest(C.NON_CONTENT_SELECTOR) && isVisible(parent));
      }
      if (!visibleParents.get(parent)) continue;
      range.selectNodeContents(node);
      const region = regionOf(parent);
      region.text_chars += value.length;
      const rect = range.getBoundingClientRect();
      lines.push({ value, region, parent, rect, inView: intersectsViewport(rect) });
    }
    return lines;
  };

  // Lines are taken until the limit is reached, then joined and cut. Returns the text and each line's share.
  const fitText = (lines) => {
    const taken = [];
    let length = 0;
    for (const line of lines) {
      if (length >= C.TEXT_LIMIT) break;
      taken.push(line);
      length += line.value.length;
    }
    let position = 0;
    for (const line of taken) {
      line.shown = Math.max(0, Math.min(line.value.length, C.TEXT_LIMIT - position));
      position += line.value.length + 1;
    }
    return {
      text: taken
        .map((line) => line.value)
        .join("\n")
        .slice(0, C.TEXT_LIMIT),
      taken,
    };
  };

  // Without a view: viewport in DOM order. With one: grouped by region in view order.
  const viewText = (lines) => {
    const groups = new Map();
    for (const line of lines) {
      const decision = decide(line.region);
      if (decision.view === "skip" || (!decision.whole && !line.inView)) continue;
      if (!groups.has(line.region)) groups.set(line.region, []);
      groups.get(line.region).push(line);
    }
    const ordered = [...groups].sort(([a], [b]) => decide(a).order - decide(b).order);
    return fitText(ordered.flatMap(([region, regionLines]) => [{ value: `## ${region.key}` }, ...regionLines]));
  };

  // ---- Read layer ----
  const READ_KINDS = ["outline", "text", "table", "list", "link", "control", "media"];
  const TABLE_SELECTOR = 'table,[role="table"],[role="grid"]';
  const LIST_ITEM_SELECTOR = 'li,[role="listitem"]';
  const LINK_SELECTOR = 'a[href],[role="link"]';
  const CONTROL_SELECTOR =
    'button,input,select,textarea,summary,label,[contenteditable="true"],' +
    C.INTERACTIVE_ROLES.filter((role) => role !== "link")
      .map((role) => `[role="${role}"]`)
      .join(",");
  const MEDIA_SELECTOR = 'img[alt],[role="img"][aria-label],figcaption';
  const NOT_TEXT_SELECTOR = [
    TABLE_SELECTOR,
    LIST_ITEM_SELECTOR,
    C.HEADING_SELECTOR,
    LINK_SELECTOR,
    CONTROL_SELECTOR,
    "figcaption",
    "option",
  ].join(",");

  const requested = Array.isArray(view?.read) ? view.read : [];
  const readKinds = requested.some((kind) => READ_KINDS.includes(kind))
    ? READ_KINDS.filter((kind) => kind === "outline" || requested.includes(kind))
    : [];

  const readElements = (selector) =>
    queryAllDeep(selector).filter(
      (element) => !element.closest(C.NON_CONTENT_SELECTOR) && isVisible(element) && readable(element),
    );

  // Lines with a position; a position line is written only when it changes.
  const placed = (items) => {
    const out = [];
    let last = null;
    for (const { at, line } of items) {
      if (at !== last) out.push(`@ ${at}`);
      out.push(line);
      last = at;
    }
    return out;
  };

  const buildReadLayer = (lines) => {
    if (!readKinds.length) return null;
    const readers = {
      outline: () =>
        placed(
          readElements(C.HEADING_SELECTOR)
            .map((heading) => {
              const level = /^H[1-6]$/.test(heading.tagName)
                ? heading.tagName.toLowerCase()
                : `h${heading.getAttribute("aria-level") || 2}`;
              return {
                at: where(heading.getBoundingClientRect()),
                line: `${level} ${squash(heading.textContent, 120)}`,
              };
            })
            .filter((item) => item.line.length > 3),
        ),
      text: () =>
        placed(
          lines
            .filter((line) => !closestDeep(line.parent, NOT_TEXT_SELECTOR) && readable(line.parent))
            .map((line) => ({ at: where(line.rect), line: squash(line.value, 1000) }))
            .filter((item) => item.at !== "in view"),
        ),
      table: () =>
        readElements(TABLE_SELECTOR)
          .filter((table) => !table.parentElement?.closest(TABLE_SELECTOR))
          .flatMap((table, index) => {
            const rows = [...table.querySelectorAll('tr,[role="row"]')]
              .filter((row) => row.closest(TABLE_SELECTOR) === table && isVisible(row))
              .map((row) =>
                [
                  ...row.querySelectorAll(
                    'th,td,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]',
                  ),
                ]
                  .filter((cell) => cell.closest('tr,[role="row"]') === row)
                  // biome-ignore lint/performance/useDomNodeTextContent: rendered cell text excludes hidden markup.
                  .map((cell) => squash(cell.innerText, 80))
                  .join(" | "),
              )
              .filter((row) => row.replace(/[\s|]/g, ""));
            const caption = squash(table.querySelector("caption")?.textContent || table.getAttribute("aria-label"), 80);
            return [
              `## table ${index + 1} @ ${where(table.getBoundingClientRect())}${caption ? `: ${caption}` : ""} (${rows.length} rows)`,
              ...rows,
            ];
          }),
      list: () => {
        const items = readElements(LIST_ITEM_SELECTOR).filter(
          (item) => !item.parentElement?.closest(LIST_ITEM_SELECTOR) && !item.closest(TABLE_SELECTOR),
        );
        return placed(
          items
            // biome-ignore lint/performance/useDomNodeTextContent: rendered item text excludes hidden markup.
            .map((item) => ({ at: where(item.getBoundingClientRect()), line: `- ${squash(item.innerText, 300)}` }))
            .filter((item) => item.line.length > 2 && item.at !== "in view"),
        );
      },
      link: () => {
        const seen = new Set();
        return placed(
          readElements(LINK_SELECTOR)
            .map((link) => ({ at: where(link.getBoundingClientRect()), line: `- ${squash(accessibleName(link), 80)}` }))
            .filter(
              (item) => item.at !== "in view" && item.line.length > 2 && !seen.has(item.line) && seen.add(item.line),
            ),
        );
      },
      control: () =>
        placed(
          readElements(CONTROL_SELECTOR)
            .filter((element) => !element.matches(LINK_SELECTOR) && !(element.type === "hidden"))
            .map((element) => ({
              at: where(element.getBoundingClientRect()),
              line: `- ${roleOf(element) || element.tagName.toLowerCase()} ${JSON.stringify(squash(accessibleName(element), 60))}`,
            }))
            .filter((item) => item.at !== "in view"),
        ),
      media: () =>
        placed(
          readElements(MEDIA_SELECTOR)
            .map((element) => ({
              at: where(element.getBoundingClientRect()),
              line: `- ${squash(
                element.matches("figcaption")
                  ? element.textContent
                  : element.getAttribute("alt") || element.getAttribute("aria-label"),
                160,
              )}`,
            }))
            .filter((item) => item.line.length > 2),
        ),
    };
    const full = readKinds.map((kind) => {
      const kindLines = readers[kind]();
      return { kind, lines: kindLines, total: kindLines.reduce((sum, line) => sum + line.length + 1, 0) };
    });
    let remaining = C.READ_LIMIT;
    const share = new Map();
    [...full]
      .sort((a, b) => a.total - b.total)
      .forEach((entry, index, sorted) => {
        const given = Math.min(entry.total, Math.floor(remaining / (sorted.length - index)));
        share.set(entry.kind, given);
        remaining -= given;
      });
    const chars = {};
    const sections = full.map(({ kind, lines: kindLines, total }) => {
      const taken = [];
      let used = 0;
      for (const line of kindLines) {
        if (used + line.length + 1 > share.get(kind)) {
          if (!taken.length && share.get(kind) > 1) taken.push(line.slice(0, share.get(kind) - 1));
          break;
        }
        taken.push(line);
        used += line.length + 1;
      }
      const shown = taken.reduce((sum, line) => sum + line.length + 1, 0);
      chars[kind] = [shown, total];
      const more = total > shown ? [`... ${total - shown} more characters`] : [];
      return [`# ${kind}${kindLines.length ? "" : " (none)"}`, ...taken, ...more].join("\n");
    });
    return { kinds: readKinds, text: sections.join("\n"), chars, limit: C.READ_LIMIT };
  };

  return { readKinds, textLines, fitText, viewText, buildReadLayer };
};
