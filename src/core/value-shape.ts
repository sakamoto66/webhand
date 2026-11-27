/**
 * The shape of a typed date, such as 99/99/9999, so a run log tells which format was used without the text. Only
 * texts that read as a date have one: anything else (names, addresses, phone numbers) gets none. A shape does not
 * tell day from month.
 */

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const DATES = [
  /^(?:\d{4}([-/.])\d{1,2}\1\d{1,2}|\d{1,2}([-/.])\d{1,2}\2(?:\d{4}|\d{2}))$/,
  /^\d{4}年\s?\d{1,2}月\s?\d{1,2}日$/,
  new RegExp(`^${MONTH}\\.? \\d{1,2},? \\d{4}$`, "i"),
  new RegExp(`^\\d{1,2}[ -]${MONTH}\\.?[ -]\\d{4}$`, "i"),
];

export function dateShape(text: string): string | null {
  if (!DATES.some((date) => date.test(text))) return null;
  // A full month name and a short one are different formats ("May" reads as either; it is taken as short).
  return text.replace(/[a-z]+/gi, (name) => (name.length > 3 ? "Month" : "Mon")).replace(/\d/g, "9");
}
