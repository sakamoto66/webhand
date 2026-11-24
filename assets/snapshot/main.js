(view, mods) => {
  const C = mods.constants();
  const nodes = mods.nodes();
  const dom = mods.dom();
  const el = mods.elements(C, dom);
  const fresh = mods.freshness(C, nodes, dom, el);
  const reg = mods.regions(view, C, dom, el);
  const readMod = mods.readLayer(view, C, dom, el, reg);
  const actMod = mods.actions(view, C, nodes, dom, el, reg, readMod.readKinds);

  const { state } = nodes;
  const { regions, pageRegion, regionOf, actionRegions, viewing, decide, positionOf } = reg;
  const { reveals, beyond } = actMod;

  const actions = actMod.collectActions();
  actMod.attachDuplicateContexts([...actions, ...beyond.map((entry) => entry.action)]);
  const lines = readMod.textLines();
  // The freshness marker always uses the viewport text in DOM order, whatever the view.
  const base = readMod.fitText(lines.filter((line) => line.inView));
  const text = base.text;
  const shown = viewing ? readMod.viewText(lines) : base;
  for (const line of shown.taken) if (line.region) line.region.shown_chars += line.shown;
  const height = document.documentElement.scrollHeight;
  const formFields = fresh.formFieldsKey();
  const page_key = [...fresh.viewportKey(), formFields];

  const guards = {};
  for (const action of actions) {
    if (!(action.node in guards)) guards[action.node] = state.guard(state.nodes.get(action.node));
  }

  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics = actions.map(({ rect, ...action }) => action);
  const marker = [...fresh.viewportKey(), document.title, text, semantics, formFields];

  let chosen = actions;
  if (viewing) {
    chosen = actions
      .filter((action) => decide(actionRegions.get(action)).view !== "skip")
      .map((action, index) => ({ action, index }))
      .sort(
        (a, b) =>
          decide(actionRegions.get(a.action)).order - decide(actionRegions.get(b.action)).order || a.index - b.index,
      )
      .map(({ action }) => action);
  }
  chosen = actMod.takeCapped(chosen, C.MAX_ACTIONS, (action) => action);
  const omitted_actions = actions.length - chosen.length;
  // The region key goes on the action for the run log only; the marker above was taken without it.
  for (const action of chosen) {
    const region = actionRegions.get(action);
    region.shown_actions++;
    action.region = region.key;
  }

  // v2: the nearest elements beyond the viewport, back in DOM order, after those in view.
  const beyondKept = actMod
    .takeCapped(
      beyond
        .map((entry, index) => ({ ...entry, index }))
        .filter(({ action }) => !viewing || decide(actionRegions.get(action)).view !== "skip")
        .sort((a, b) => a.distance - b.distance || a.index - b.index),
      C.MAX_BEYOND,
      (entry) => entry.action,
    )
    .sort((a, b) => a.index - b.index)
    .map(({ action }) => action);
  for (const action of beyondKept) {
    if (!(action.node in guards)) guards[action.node] = state.guard(state.nodes.get(action.node));
    action.region = actionRegions.get(action).key;
  }

  // The nearest and the farthest are kept: the end of a list is what loads more of it.
  const kept =
    reveals.length > C.MAX_REVEALS
      ? [...reveals.slice(0, C.MAX_REVEALS / 2), ...reveals.slice(-C.MAX_REVEALS / 2)]
      : reveals;
  for (const reveal of kept) {
    if (!(reveal.node in guards)) guards[reveal.node] = state.guard(state.nodes.get(reveal.node));
  }
  chosen = [...chosen, ...beyondKept, ...kept];
  chosen.forEach((action, index) => {
    action.id = `e${index + 1}`;
  });
  if (scrollY + innerHeight < height - 2) {
    chosen.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: C.SCROLL_STEP });
  }
  if (scrollY > 0) chosen.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -C.SCROLL_STEP });
  chosen.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });

  // The page's outline: every region with content, how much of it is shown, and where it is.
  const outline = [pageRegion, ...regions]
    .filter((region) => region.text_chars || region.actions || region.offscreen_actions)
    .filter((region) => !region.element || el.isVisible(region.element));
  const regionSummary = outline.slice(0, C.MAX_REGIONS).map((region) => {
    const summary = {
      key: region.key,
      position: positionOf(region),
      text_chars: region.text_chars,
      shown_chars: region.shown_chars,
      actions: region.actions,
      shown_actions: region.shown_actions,
      offscreen_actions: region.offscreen_actions,
    };
    if (viewing && decide(region).view) summary.view = decide(region).view;
    return summary;
  });

  state.region = (element) => regionOf(element).key;
  const read = readMod.buildReadLayer(lines);

  return {
    url: location.href,
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    text: shown.text,
    scroll: { y: scrollY, height },
    actions: chosen,
    marker,
    page_key,
    guards,
    omitted_actions,
    regions: regionSummary,
    omitted_regions: outline.length - regionSummary.length,
    ...(read ? { read } : {}),
    ...(reveals.length > kept.length ? { omitted_reveals: reveals.length - kept.length } : {}),
    ...(beyond.length > beyondKept.length ? { omitted_beyond: beyond.length - beyondKept.length } : {}),
  };
};
