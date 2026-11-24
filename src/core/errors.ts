/**
 * Base error class for user-facing configuration, input, and domain errors.
 * The CLI maps any WebhandError to CliExit (exit code 1) in one place.
 */
export class WebhandError extends Error {
  override name = "WebhandError";
}

/** A session, profile, login, or browser startup/shutdown problem. */
export class SessionError extends WebhandError {
  override name = "SessionError";
}

/** A runbook or service.toml cannot be used as written. */
export class RunbookError extends WebhandError {
  override name = "RunbookError";
}

/** A saved check file (.webhand/checks) cannot be used as written. */
export class CheckFileError extends WebhandError {
  override name = "CheckFileError";
}

/** An expectation string given to `check` is malformed. */
export class ExpectationError extends WebhandError {
  override name = "ExpectationError";
}

/** Invalid options given to `extract`. */
export class ExtractError extends WebhandError {
  override name = "ExtractError";
}

/** Invalid options given to `--explore`. */
export class ExploreError extends WebhandError {
  override name = "ExploreError";
}
