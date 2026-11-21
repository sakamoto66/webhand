// Reads data from the page as it is, for `webhand extract`. Nothing is clicked, typed or scrolled. The result is
// plain JSON: the items of one kind with where each came from, and what could not be seen. Values are the page's
// own text, only whitespace squashed. Password fields are never read. spec = {kind, within}.
(spec => {
  const squash = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const SKIP = 'script,style,noscript,template';
  const hiddenByPage = element => !!element.closest('[aria-hidden="true"],[inert],[hidden],' + SKIP);
  const shown = element => {
    if (hiddenByPage(element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const WITHIN = {
    main: 'main,[role="main"]', nav: 'nav,[role="navigation"]', header: 'header,[role="banner"]',
    footer: 'footer,[role="contentinfo"]', aside: 'aside,[role="complementary"]', form: 'form,[role="form"]',
    dialog: 'dialog,[role="dialog"],[role="alertdialog"]', search: '[role="search"]', table: 'table,[role="table"]',
  };
  let roots = [document.body];
  let withinFound = true;
  if (spec.within) {
    const selector = WITHIN[spec.within];
    roots = selector ? [...document.querySelectorAll(selector)].filter(shown) : [];
    withinFound = roots.length > 0;
  }
  const inScope = element => roots.some(root => root === element || root.contains(element));
  const find = selector => [...document.querySelectorAll(selector)].filter(element => inScope(element));
  const regionOf = element => {
    const hit = element.closest('main,[role="main"],nav,[role="navigation"],header,[role="banner"],footer,' +
      '[role="contentinfo"],aside,[role="complementary"],form,dialog,[role="dialog"]');
    if (!hit) return 'page';
    const role = hit.getAttribute('role');
    return role || hit.tagName.toLowerCase();
  };
  const nameOf = element => squash(element.getAttribute('aria-label') ||
    (element.labels && element.labels[0] && element.labels[0].textContent) ||
    (element.id && document.querySelector('label[for="' + CSS.escape(element.id) + '"]') &&
      document.querySelector('label[for="' + CSS.escape(element.id) + '"]').textContent) ||
    (element.closest('label') && element.closest('label').textContent) ||
    element.getAttribute('placeholder') || element.getAttribute('name') || '');

  const items = [];
  const notes = [];
  const reader = {
    table: () => {
      const tables = find('table,[role="table"],[role="grid"]')
        .filter(table => !table.parentElement || !table.parentElement.closest('table,[role="table"],[role="grid"]'));
      tables.forEach((table, at) => {
        const shownTable = shown(table);
        const rowElements = [...table.querySelectorAll('tr,[role="row"]')]
          .filter(row => row.closest('table,[role="table"],[role="grid"]') === table);
        const grid = [];
        let spans = false;
        const carry = [];
        const hiddenRows = rowElements.filter(row => !shown(row)).length;
        rowElements.filter(row => shown(row)).forEach((row, y) => {
          const cells = [...row.children].filter(cell => /^(TH|TD)$/.test(cell.tagName) ||
            ['cell', 'gridcell', 'columnheader', 'rowheader'].includes(cell.getAttribute('role')));
          const out = [];
          let x = 0;
          const take = () => {
            while (carry[x] && carry[x].left > 0) { out[x] = carry[x].text; carry[x].left -= 1; x += 1; }
          };
          take();
          for (const cell of cells) {
            const text = squash(cell.innerText);
            const colspan = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
            const rowspan = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
            if (colspan > 1 || rowspan > 1) spans = true;
            for (let c = 0; c < colspan; c += 1) {
              out[x] = text;
              if (rowspan > 1) carry[x] = {text, left: rowspan - 1};
              x += 1;
              take();
            }
          }
          grid.push({cells: out.map(value => value === undefined ? '' : value), th: cells.length > 0 &&
            cells.every(cell => cell.tagName === 'TH' || cell.getAttribute('role') === 'columnheader'), y});
        });
        const headIndex = grid.findIndex(row => row.th);
        const header = headIndex >= 0 ? grid[headIndex].cells : null;
        const body = grid.filter((_, i) => i !== headIndex && grid[i].cells.some(value => value !== ''));
        items.push({
          kind: 'table', at: at + 1, region: regionOf(table), shown: shownTable,
          caption: squash((table.querySelector('caption') || {}).textContent || table.getAttribute('aria-label')),
          header, rows: body.map(row => row.cells), spans, hidden_rows: hiddenRows,
        });
      });
    },
    list: () => {
      find('li,[role="listitem"]').filter(li => shown(li) &&
        !(li.parentElement && li.parentElement.closest('li,[role="listitem"]')) &&
        !li.closest('table,[role="table"]')).forEach((li, at) => {
        items.push({kind: 'list', at: at + 1, region: regionOf(li), text: squash(li.innerText)});
      });
    },
    link: () => {
      find('a[href],[role="link"]').filter(shown).forEach((link, at) => {
        items.push({kind: 'link', at: at + 1, region: regionOf(link),
          name: squash(link.getAttribute('aria-label') || link.innerText || link.getAttribute('title')),
          href: link.href || link.getAttribute('href') || ''});
      });
    },
    fields: () => {
      find('input,textarea,select').filter(shown).forEach((field, at) => {
        const type = (field.type || field.tagName).toLowerCase();
        if (['password', 'hidden', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) {
          if (type === 'password') notes.push('password');
          return;
        }
        const checkable = type === 'checkbox' || type === 'radio';
        const value = field.tagName === 'SELECT' ? [...field.selectedOptions].map(o => squash(o.textContent)).join(', ')
          : checkable ? String(field.checked) : String(field.value);
        items.push({kind: 'fields', at: at + 1, region: regionOf(field), label: nameOf(field), type, value});
      });
    },
    text: () => {
      let heading = '';
      let number = 0;
      let section = null;
      for (const element of find('h1,h2,h3,h4,h5,h6,[role="heading"],p,pre,blockquote,dt,dd')) {
        if (!shown(element) || element.closest('table,[role="table"]')) continue;
        const text = squash(element.innerText);
        if (!text) continue;
        if (/^H[1-6]$/.test(element.tagName) || element.getAttribute('role') === 'heading') {
          heading = text;
          section = null;
        } else {
          if (!section) {
            number += 1;
            section = {kind: 'text', at: number, region: regionOf(element), heading, text: ''};
            items.push(section);
          }
          section.text += (section.text ? '\n' : '') + text;
        }
      }
    },
  };
  if (reader[spec.kind]) reader[spec.kind]();
  const frames = [...document.querySelectorAll('iframe,frame')].filter(shown).length;
  const canvases = document.querySelectorAll('canvas').length;
  const objects = document.querySelectorAll('object,embed').length;
  return {
    url: location.href, title: document.title, ready: document.readyState === 'complete',
    busy: document.querySelectorAll('[aria-busy="true"]').length,
    within_found: withinFound, unseen: {frames, canvases, objects}, notes, items,
  };
})
