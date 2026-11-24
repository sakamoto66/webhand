/** Page-level health, bot-check, status, and unseen-parts probe scripts (read-only). */

// A frame smaller than this on either side (a tracking pixel, an ad slot) is neither read nor counted as unseen.
export const MIN_FRAME_SIDE = 20;

/**
 * Signs of a bot check, for the run log. A marker is a sign, not proof: a normal page can embed a CAPTCHA
 * widget. Only element presence is read, never text or field values.
 */
const CHALLENGES: [string, string][] = [
  [
    "cloudflare",
    'iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"], #challenge-form, .cf-turnstile',
  ],
  ["recaptcha", 'iframe[src*="recaptcha"], .g-recaptcha'],
  ["hcaptcha", 'iframe[src*="hcaptcha.com"], .h-captcha'],
  ["datadome", '[src*="captcha-delivery.com"]'],
  ["perimeterx", "#px-captcha"],
  ["arkose", 'iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha"]'],
];

const FIND_CHALLENGES = `${JSON.stringify(CHALLENGES)}.filter(([, selector]) => document.querySelector(selector)).map(([name]) => name)`;

export const PAGE_CHECK = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const found = ${FIND_CHALLENGES};
  return {
    http_status: nav && nav.responseStatus ? nav.responseStatus : null,
    title: document.title.slice(0, 120),
    challenge: found,
    text_chars: document.body ? document.body.innerText.length : 0,
  };
})()`;

// v2: the kind of page, from signs only (element presence and the document's HTTP status, never text or values).
export const STATUS = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility !== 'hidden'; };
  const any = selector => [...document.querySelectorAll(selector)].some(shown);
  const nav = performance.getEntriesByType('navigation')[0];
  const http = nav && nav.responseStatus ? nav.responseStatus : null;
  const signs = ${FIND_CHALLENGES};
  const kind = http >= 400 ? 'error' : signs.length ? 'check' : any('input[type="password"]') ? 'sign_in'
    : any('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]') ? 'dialog' : 'ready';
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  const framed = [...document.querySelectorAll('iframe,frame')].filter(e => { const r=e.getBoundingClientRect(); return r.width>=${MIN_FRAME_SIDE} && r.height>=${MIN_FRAME_SIDE} && getComputedStyle(e).visibility !== 'hidden'; }).length;
  const unseen = {frames: framed, canvases: count('canvas'), objects: count('object,embed')};
  return {kind, ...(http ? {http_status: http} : {}), ...(signs.length ? {signs} : {}), unseen};
})()`;

export const UNSEEN = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  const framed = [...document.querySelectorAll('iframe,frame')].filter(e => { const r=e.getBoundingClientRect(); return r.width>=${MIN_FRAME_SIDE} && r.height>=${MIN_FRAME_SIDE}; }).length;
  return {frames: framed, canvases: count('canvas'), objects: count('object,embed')};
})()`;
