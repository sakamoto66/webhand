/** Target resolution, reveal, focus check, and dropdown option selection scripts. */

// Node ids are code-owned references to observed elements, never model output.
// Where to click an observed element, or why not: gone, disabled, hidden, read-only, outside the viewport, or
// covered (with what covers it).
export const RESOLVE_TARGET = `(action => {
  const c=window.__browserLab, e=c?.nodes.get(action.node);
  if (!e?.isConnected) return {reason:'gone'};
  if (e.matches(':disabled') || c.closest(e,'[aria-disabled="true"],[inert]')) return {reason:'disabled'};
  const toggle=e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type);
  const editor=e.tagName==='TEXTAREA' ? c.closest(e, '.monaco-editor,.ace_editor,.CodeMirror') : null;
  const ownVisible=e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const hiddenByAria=Boolean(c.closest(e,'[aria-hidden="true"],[inert]'));
  const labels=[...(e.labels || [])].filter(l=>l.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  const editorVisible=Boolean(editor && !hiddenByAria && editor.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  if (!ownVisible && !(toggle && !hiddenByAria && labels.length) && !editorVisible) return {reason:'hidden'};
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return {reason:'read_only'};
  const tryPoint=(x,y)=>{
    if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
    if (c.hit(e,x,y)) return {x,y};
    covered ??= c.cover(x,y);
    return null;
  };
  let covered=null;
  if (ownVisible) {
    for (const r of [e.getBoundingClientRect(), ...e.getClientRects()]) {
      if (!r.width || !r.height) continue;
      const hit=tryPoint(r.x+r.width/2, r.y+r.height/2);
      if (hit) return hit;
    }
  }
  for (const label of labels) {
    const r=label.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const y=r.y+r.height/2, edge=Math.min(8, r.width/4);
    for (const x of [r.x+r.width/2, r.right-edge, r.left+edge, r.x+r.width*0.75, r.x+r.width*0.25]) {
      const hit=tryPoint(x, y);
      if (hit) return hit;
    }
  }
  if (editorVisible && editor) {
    const surface=editor.querySelector('.view-lines,.ace_content,.CodeMirror-lines') || editor;
    const r=surface.getBoundingClientRect();
    if (r.width && r.height) {
      for (const [x, y] of [
        [r.x+r.width/2, r.y+r.height/2],
        [r.x+Math.min(24, r.width/4), r.y+Math.min(24, r.height/4)],
      ]) {
        if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
        const top=c.top(x, y);
        if (top && editor.contains(top) && !top.closest('dialog,[role="dialog"],[aria-modal="true"],button,a[href]')) {
          return {x, y, widget:true};
        }
        covered ??= c.cover(x, y);
      }
    }
  }
  return covered ? {reason:'covered', cover:covered} : {reason:'outside'};
})`;

// Scrolls an observed element (or its visible label / code-editor surface when the input itself is hidden) into view.
export const REVEAL = `(node => {
  const c=window.__browserLab, e=c?.nodes.get(node);
  if (!e?.isConnected) return false;
  let target=e;
  if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) {
    if (e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type)) {
      target=[...(e.labels || [])].find(l=>l.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) || e;
    } else if (e.tagName==='TEXTAREA') {
      target=c.closest(e, '.monaco-editor,.ace_editor,.CodeMirror') || e;
    }
  }
  target.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
  return true;
})`;

// Checks whether an observed node currently holds keyboard focus (in the document or its shadow root).
export const IS_FOCUSED = `(node => {
  const e=window.__browserLab?.nodes.get(node);
  if (!e?.isConnected) return false;
  const root=e.getRootNode();
  return root.activeElement===e || document.activeElement===e;
})`;

export const SELECT_OPTION = `(action => {
  const e=window.__browserLab.nodes.get(action.node);
  if (e.tagName!=='SELECT') return false;
  const opt=[...e.options].find(o=>o.value===action.value &&
      !o.disabled && !o.closest('optgroup[disabled]'));
  if (!opt) return false;
  if (e.multiple) opt.selected=!action.deselect;
  else e.value=action.value;
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})`;
