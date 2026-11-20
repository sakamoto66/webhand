/** Chrome (or another engine) cannot be started as asked. */
export class SessionError extends Error {
  override name = "SessionError";
}
