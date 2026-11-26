/** List/table item reading scripts used by compare and collect scans (read-only). */

// The text of the row, card, or list item each observed element is in, for comparing items. Page text only;
// field values are not part of innerText.
export const CONTEXTS = `(nodes => {
  const c=window.__browserLab, out={};
  for (const node of nodes) {
    const e=c?.nodes.get(node);
    if (!e?.isConnected) continue;
    const item=e.closest('tr,li,[role="row"],[role="listitem"],article,[role="article"]') || e.parentElement;
    out[node]=String(item?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  }
  return out;
})`;

// The items of lists and tables, header rows left out, in document order. drilldown finds its rows with it too.
export const ITEMS = `(() => {
  const ROW='tr,[role="row"]', BLOCK=new Set(['DIV','LI','ARTICLE','SECTION','A','DD']);
  const SKIP='nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="dialog"]';
  const items=new Set(document.querySelectorAll(ROW));
  for (const parent of document.querySelectorAll('body *')) {
    if (parent.childElementCount<3) continue;
    const groups=new Map();
    for (const child of parent.children) {
      if (!BLOCK.has(child.tagName) && !child.matches('[role="listitem"],[role="article"]')) continue;
      const key=child.tagName+'|'+child.getAttribute('class')+'|'+child.getAttribute('role');
      groups.set(key, [...(groups.get(key) || []), child]);
    }
    for (const group of groups.values()) {
      if (group.length<3) continue;
      for (const e of group) if ((e.textContent || '').trim()) items.add(e);
    }
  }
  const length=e=>(e.textContent || '').replace(/\\s+/g, '').length;
  const up=new Map(), kids=new Map();
  for (const e of items) {
    let a=e.parentElement;
    while (a && !items.has(a)) a=a.parentElement;
    up.set(e, a);
    if (a) kids.set(a, [...(kids.get(a) || []), e]);
  }
  const wrapper=e=>{
    const inner=kids.get(e) || [];
    return inner.length>=2 && (length(e)>1500 || inner.reduce((n,d)=>n+length(d),0)>=0.85*length(e));
  };
  const kept=e=>{
    if (e.closest(SKIP) || wrapper(e)) return false;
    for (let a=up.get(e); a; a=up.get(a)) if (!a.closest(SKIP) && !wrapper(a)) return false;
    return true;
  };
  const header=e=>e.querySelector('th,[role="columnheader"]') && !e.querySelector('td,[role="cell"],[role="gridcell"]');
  return [...items].filter(e=>!header(e) && kept(e))
    .sort((a,b)=>a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
})`;

export const ROWS = `(() => {
  const out=[];
  for (const e of ${ITEMS}()) {
    const r=e.getBoundingClientRect();
    if (r.height<=0 || r.width<=0 || r.bottom<=0 || r.top>=innerHeight) continue;
    const text=String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    if (text) out.push(text);
  }
  return out;
})()`;

// Where the main list ends: the bottom, in the viewport, of the last item of the longest list.
export const LIST_END = `(() => {
  const sig=e=>e.tagName+'|'+e.getAttribute('class');
  const lists=new Map();
  for (const e of ${ITEMS}()) {
    if (!(e.getBoundingClientRect().height>0)) continue;
    const key=sig(e)+'<'+(e.parentElement ? sig(e.parentElement) : '');
    lists.set(key, [...(lists.get(key) || []), e]);
  }
  let longest=[];
  for (const list of lists.values()) if (list.length>longest.length) longest=list;
  return longest.length>=3 ? Math.round(longest.at(-1).getBoundingClientRect().bottom) : null;
})()`;
