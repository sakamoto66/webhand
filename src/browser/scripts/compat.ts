/** Engine compatibility polyfills (Obscura) and popup/new-window tracking scripts. */

/**
 * Notes what asks for a new window: window.open and a click on a link with target=_blank. Nothing is stopped or
 * changed; the browser does what it does. Installed once per document, and read with TAKE_WINDOWS.
 */
export const TRACK_WINDOWS = `(() => {
  if (window.__webhandWindows) return;
  const asked = [];
  window.__webhandWindows = asked;
  const open = window.open;
  window.open = function (url, ...rest) {
    let where = String(url ?? '');
    try { where = new URL(where, document.baseURI).href; } catch (e) {}
    asked.push(where);
    return open.call(this, url, ...rest);
  };
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[target],area[target]') : null;
    if (link && link.target === '_blank') asked.push(link.href);
  }, true);
})()`;

export const TAKE_WINDOWS = "(() => (window.__webhandWindows ?? []).splice(0))()";

/**
 * What Obscura lacks that snapshot reads or a page's own script uses. Added to the page, so snapshot stays the
 * same for every engine. Installed once per document.
 */
export const COMPAT = `(() => {
  if (window.__webhandCompat) return;
  window.__webhandCompat = true;
  const define = (proto, name, descriptor) => {
    try { if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, ...descriptor }); } catch (e) {}
  };
  try {
    Object.defineProperty(HTMLSelectElement.prototype, 'selectedOptions', {
      configurable: true,
      get() { return [...this.options].filter(option => option.selected); },
    });
  } catch (e) {}
  define(HTMLElement.prototype, 'isContentEditable', {
    get() {
      for (let node = this; node instanceof Element; node = node.parentElement) {
        const value = node.getAttribute('contenteditable');
        if (value !== null) return value !== 'false';
      }
      return false;
    },
  });
  // A name that is not a property is looked up among the controls (or, for a collection, its named items).
  const named = (proto, lookup) => {
    try {
      const parent = Object.getPrototypeOf(proto);
      Object.setPrototypeOf(proto, new Proxy(parent, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && !(prop in target)) {
            try { const hit = lookup(receiver, prop); if (hit) return hit; } catch (e) {}
          }
          return Reflect.get(target, prop, receiver);
        },
      }));
    } catch (e) {}
  };
  {
    named(HTMLFormElement.prototype, (form, name) => form.elements && form.elements[name]);
    // document.forms is a NodeList here, which has no named items: wrap it so document.forms.id finds the form.
    const forms = Object.getOwnPropertyDescriptor(Document.prototype, 'forms');
    if (forms && forms.get) {
      Object.defineProperty(Document.prototype, 'forms', {
        configurable: true,
        get() {
          const list = forms.get.call(this);
          return new Proxy(list, {
            get(target, prop) {
              if (typeof prop === 'string' && !(prop in target)) {
                for (const form of target) if (form.id === prop || form.name === prop) return form;
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
    }
  }
})()`;
