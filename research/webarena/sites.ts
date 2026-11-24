/** Per-site definitions (placeholders, default URLs, header/form login specs) for WebArena-Verified. */

export class WebArenaError extends Error {
  override name = "WebArenaError";
}

interface FormLoginSpec {
  loginPath: string;
  userFields: string[];
  userSelector: string;
  passwordSelector: string;
  submitSelector: string;
}

export interface SiteSpec {
  id: string;
  placeholder: string;
  defaultUrl: string;
  /** webarena-verified 1.2.3 only implements HTTP header Auto-Login for shopping_admin. */
  headerLogin?: { header: string; userFields: string[] };
  formLogin?: FormLoginSpec;
}

const SITE_LIST: SiteSpec[] = [
  {
    id: "shopping",
    placeholder: "__SHOPPING__",
    defaultUrl: "http://localhost:7770",
    formLogin: {
      loginPath: "/customer/account/login",
      userFields: ["email", "username"],
      userSelector: 'input#email[name="login[username]"], input[name="login[username]"]',
      passwordSelector: 'input#pass[name="login[password]"], input[name="login[password]"]',
      submitSelector: 'button#send2, form#login-form button[type="submit"]',
    },
  },
  {
    id: "shopping_admin",
    placeholder: "__SHOPPING_ADMIN__",
    defaultUrl: "http://localhost:7780/admin",
    headerLogin: { header: "X-M2-Admin-Auto-Login", userFields: ["username", "email"] },
    formLogin: {
      loginPath: "",
      userFields: ["username", "email"],
      userSelector: 'input#username, input[name="login[username]"]',
      passwordSelector: 'input#login, input[name="login[password]"]',
      submitSelector: 'button.action-login, button[type="submit"]',
    },
  },
  {
    id: "reddit",
    placeholder: "__REDDIT__",
    defaultUrl: "http://localhost:9999",
    formLogin: {
      loginPath: "/login",
      userFields: ["username", "email"],
      userSelector: 'input#login-username, input[name="_username"]',
      passwordSelector: 'input#login-password, input[name="_password"]',
      submitSelector: 'button[type="submit"]',
    },
  },
  {
    id: "gitlab",
    placeholder: "__GITLAB__",
    defaultUrl: "http://localhost:8023",
    formLogin: {
      loginPath: "/users/sign_in",
      userFields: ["username", "email"],
      userSelector: 'input#user_login, input[name="user[login]"]',
      passwordSelector: 'input#user_password, input[name="user[password]"]',
      submitSelector: 'button[type="submit"], input[type="submit"][name="commit"]',
    },
  },
  {
    id: "wikipedia",
    placeholder: "__WIKIPEDIA__",
    defaultUrl: "http://localhost:8888",
  },
  {
    id: "map",
    placeholder: "__MAP__",
    defaultUrl: "http://localhost:3030",
  },
];

export const SITES = SITE_LIST;
export const SITES_BY_ID = new Map<string, SiteSpec>(SITE_LIST.map((site) => [site.id, site]));

/** Normalizes keys like "__SHOPPING_ADMIN__" or "SHOPPING_ADMIN" to "shopping_admin". */
export function normalizeSiteKey(raw: string): string {
  return raw.trim().replace(/^__/, "").replace(/__$/, "").toLowerCase();
}
