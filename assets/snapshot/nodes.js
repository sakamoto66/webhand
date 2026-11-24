() => {
  // Stable node ids across snapshots of the same document.
  if (!window.__browserLab) window.__browserLab = { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const state = window.__browserLab;

  const nodeId = (element) => {
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

  return { state, nodeId, forgetDisconnected };
};
