(() => {
  if (window.__browserLabRecorder) return;
  window.__browserLabRecorder = true;
  const read = () => __SNAPSHOT__;
  const inFrame = window !== window.top;
  const secretWords = /pass|pwd|\bpw\b|secret|token|otp|cvv|cvc|card|ssn|\bpin\b|パスワード|暗証|認証コード|カード/i;
  const secretAutocomplete = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/;
  const everPassword = new WeakSet();
  const secret = (e, label) => e.type === 'password' || everPassword.has(e) ||
    secretAutocomplete.test(e.getAttribute('autocomplete') || '') ||
    secretWords.test([e.name, e.id, e.getAttribute('aria-label'), e.getAttribute('placeholder'), label].join(' '));
  // A GET form copies field values into the URL under any key, so no query value is kept.
  const safeUrl = () => {
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '<redacted>');
    if (url.hash.includes('=')) url.hash = '<redacted>';
    return url.href;
  };
  const send = event => {
    const payload = {...event, url: safeUrl()};
    window.__browserLabRecord?.(inFrame ? {...payload, kind: 'unsupported', reason: 'iframe'} : payload);
  };
  // Listeners on window see shadow DOM events retargeted to the host; use the original target.
  const origin = event => event.composedPath()[0];
  const describe = target => {
    const element = target instanceof Element ? target : target?.parentElement;
    if (!element) return null;
    read();
    return window.__browserLab?.describe(element) ??
      {role: 'none', label: (element.innerText || '').trim().slice(0, 80), element};
  };
  let timer = null;
  const sendPage = () => {
    if (inFrame) return;
    const state = read();
    if (state) window.__browserLabRecord?.({kind: 'page', url: safeUrl(), title: state.title, text: state.text.slice(0, 2000)});
  };
  const action = event => {
    send({kind: 'action', ...event});
    clearTimeout(timer);
    timer = setTimeout(sendPage, 400);
  };
  const textField = e => e.matches?.('input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=image]),textarea,select');

  addEventListener('focusin', event => {
    if (event.isTrusted && origin(event).type === 'password') everPassword.add(origin(event));
  }, true);
  addEventListener('click', event => {
    if (!event.isTrusted) return;
    const found = describe(origin(event));
    if (!found || textField(found.element) || ['checkbox', 'radio'].includes(found.element.type)) return;
    action({operation: 'click', role: found.role, label: found.label});
  }, true);
  const onChange = event => {
    if (!event.isTrusted) return;
    const found = describe(origin(event)), e = found?.element;
    if (!e) return;
    const base = {role: found.role, label: found.label};
    if (e.type === 'file') send({kind: 'unsupported', reason: 'file_input', ...base});
    else if (['checkbox', 'radio'].includes(e.type)) action({operation: 'toggle', checked: e.checked, ...base});
    else if (secret(e, found.label)) action({operation: 'fill', value: '<redacted>', ...base});
    else if (e.tagName === 'SELECT') {
      action({operation: 'select', value: [...e.selectedOptions].map(o => o.label).join(', '), ...base});
    } else action({operation: 'fill', value: e.value, ...base});
  };
  addEventListener('focusout', event => {
    if (!event.isTrusted || !origin(event).isContentEditable) return;
    const found = describe(origin(event));
    if (found) action({operation: 'fill', role: found.role, label: found.label,
      value: secret(found.element, found.label) ? '<redacted>' : found.element.innerText.slice(0, 500)});
  }, true);
  const onSubmit = event => {
    if (!event.isTrusted) return;
    action({operation: 'submit', role: 'form', label: event.target.getAttribute('aria-label') || event.target.name || ''});
  };
  // change and submit are not composed, so they stop at their shadow root and never reach window.
  // Each open shadow root gets these two listeners; composed events are heard on window only once.
  const listen = root => {
    root.addEventListener('change', onChange, true);
    root.addEventListener('submit', onSubmit, true);
  };
  listen(window);
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...args) {
    const root = attach.apply(this, args);
    if (root.mode === 'open') listen(root);
    return root;
  };
  // Declarative shadow roots are created by the parser without attachShadow.
  const listenDeclarative = () => {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    for (let e = walker.nextNode(); e; e = walker.nextNode()) if (e.shadowRoot) listen(e.shadowRoot);
  };
  addEventListener('DOMContentLoaded', listenDeclarative);
  // Enter is the only key ever looked at. Nothing else typed reaches this listener's output.
  addEventListener('keydown', event => {
    if (!event.isTrusted || event.key !== 'Enter') return;
    const found = describe(origin(event));
    if (found) action({operation: 'press_enter', role: found.role, label: found.label});
  }, true);
  addEventListener('load', sendPage);
})();
