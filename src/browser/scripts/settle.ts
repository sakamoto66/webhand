/** Waits until the document has loaded and the DOM has stayed quiet before observing. */

const SETTLE_QUIET_MS = 150;
/** Tests of the fixtures shorten the quiet time (WEBHAND_SETTLE_QUIET_MS) to run faster; people never set it. */
const settleQuietMs = () => Number(process.env.WEBHAND_SETTLE_QUIET_MS) || SETTLE_QUIET_MS;
export const SETTLE_CAP_MS = 2000;

export const settleScript = () => `new Promise(resolve => {
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  const check = () => {
    const now = performance.now();
    if (now - start >= ${SETTLE_CAP_MS} ||
        (document.readyState === 'complete' && now - last >= ${settleQuietMs()})) {
      observer.disconnect();
      resolve();
    } else setTimeout(check, 25);
  };
  check();
})`;
