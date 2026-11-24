/**
 * Command-line arguments: what a command declares (options, positionals), how argv is parsed into them with
 * argparse-style messages, and the help text. The commands themselves are in cli.ts.
 */

import { quote } from "./core/format.ts";
import { packageVersion } from "./core/fs.ts";

/** A command line that does not parse. Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

// biome-ignore lint/suspicious/noExplicitAny: parsed arguments, keyed by option name with dashes as underscores.
export type Args = Record<string, any>;

export interface OptionSpec {
  name: string;
  type: "string" | "boolean" | "int" | "float";
  multiple?: boolean;
  default?: unknown;
  choices?: string[];
  required?: boolean;
  help?: string;
  metavar?: string;
  hidden?: boolean;
}

interface PositionalSpec {
  name: string;
  optional?: boolean;
  choices?: string[];
}

export interface CommandSpec {
  help: string;
  options: OptionSpec[];
  positionals?: PositionalSpec[];
  run: (args: Args) => Promise<number>;
  /** Options that cannot be given together. */
  conflicts?: [string, string][];
  /** Hidden aliases stay callable for backward compatibility without cluttering main help. */
  hidden?: boolean;
}

function usage(name: string, spec: CommandSpec): string {
  const parts = [`usage: webhand ${name}`];
  for (const option of spec.options) {
    if (option.hidden) continue;
    const value =
      option.type === "boolean" ? "" : ` ${option.metavar ?? option.name.toUpperCase().replaceAll("-", "_")}`;
    parts.push(option.required ? `--${option.name}${value}` : `[--${option.name}${value}]`);
  }
  for (const positional of spec.positionals ?? []) {
    parts.push(positional.optional ? `[${positional.name}]` : positional.name);
  }
  return parts.join(" ");
}

function help(name: string, spec: CommandSpec): string {
  const lines = [usage(name, spec), "", spec.help, ""];
  for (const positional of spec.positionals ?? []) {
    lines.push(`  ${positional.name}${positional.choices ? ` {${positional.choices.join(",")}}` : ""}`);
  }
  for (const option of spec.options) {
    if (option.hidden) continue;
    const details = [
      option.help,
      option.choices ? `one of: ${option.choices.join(", ")}` : null,
      option.default !== undefined && option.type !== "boolean" ? `default: ${option.default}` : null,
      option.multiple ? "repeatable" : null,
    ].filter(Boolean);
    lines.push(`  --${option.name}${details.length ? `  ${details.join("; ")}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The package version, so a skill can tell which CLI it is talking to. */
function version(): string {
  return packageVersion();
}

function mainHelp(specs: Record<string, CommandSpec>): string {
  const visible = Object.entries(specs).filter(([, spec]) => !spec.hidden);
  const lines = [
    `usage: webhand {${visible.map(([name]) => name).join(",")}} ...`,
    "",
    "CLI for the Claude + Jev agent. Each call is one short process.",
    "",
  ];
  for (const [name, spec] of visible) lines.push(`  ${name.padEnd(9)} ${spec.help}`);
  lines.push(
    "",
    "  --version  Print the version",
    "  --help     Print this help; COMMAND --help prints a command's options",
  );
  return `${lines.join("\n")}\n`;
}

export interface Parsed {
  command: string;
  args: Args;
  run: (args: Args) => Promise<number>;
}

type Fail = (message: string) => UsageError;

/** What an option holds when it is not given. */
function optionDefault(option: OptionSpec): unknown {
  if (option.multiple) return [];
  return option.type === "boolean" ? false : (option.default ?? null);
}

/** The text of an option's value: after "=", or the next token. Returns it and how many tokens it took. */
function optionText(option: OptionSpec, token: string, next: string | undefined, fail: Fail): [string, number] {
  const at = token.indexOf("=");
  if (at >= 0) return [token.slice(at + 1), 0];
  if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
    throw fail(`argument --${option.name}: expected one argument`);
  }
  return [next, 1];
}

/** An option's text as its type, which must be one of its choices when it has any. */
function optionValue(option: OptionSpec, raw: string, fail: Fail): unknown {
  let value: unknown = raw;
  if (option.type === "int") {
    if (!/^\s*[-+]?\d+\s*$/.test(raw)) throw fail(`argument --${option.name}: invalid int value: ${quote(raw)}`);
    value = Number.parseInt(raw, 10);
  } else if (option.type === "float") {
    const number = Number(raw);
    if (!raw.trim() || Number.isNaN(number)) {
      throw fail(`argument --${option.name}: invalid float value: ${quote(raw)}`);
    }
    value = number;
  }
  if (option.choices && !option.choices.includes(String(value))) {
    throw fail(
      `argument --${option.name}: invalid choice: ${quote(value)} (choose from ${option.choices.map(quote).join(", ")})`,
    );
  }
  return value;
}

/** Gives the positional tokens their names, and says what is missing, extra or not a choice. */
function bindPositionals(spec: CommandSpec, positionals: string[], args: Args, fail: Fail): void {
  const declared = spec.positionals ?? [];
  const missing = declared.filter((p, i) => !p.optional && positionals[i] === undefined);
  if (missing.length) {
    throw fail(`the following arguments are required: ${missing.map((p) => p.name).join(", ")}`);
  }
  if (positionals.length > declared.length) {
    throw fail(`unrecognized arguments: ${positionals.slice(declared.length).join(" ")}`);
  }
  declared.forEach((positional, i) => {
    const value = positionals[i] ?? null;
    if (value !== null && positional.choices && !positional.choices.includes(value)) {
      throw fail(
        `argument ${positional.name}: invalid choice: ${quote(value)} (choose from ${positional.choices.map(quote).join(", ")})`,
      );
    }
    args[positional.name] = value;
  });
}

/** Options that may not go together, and options that must be given. */
function checkOptions(spec: CommandSpec, seen: Set<string>, fail: Fail): void {
  for (const [a, b] of spec.conflicts ?? []) {
    if (seen.has(a) && seen.has(b)) throw fail(`argument --${a}: not allowed with argument --${b}`);
  }
  const required = spec.options.filter((option) => option.required && !seen.has(option.name));
  if (required.length) {
    throw fail(`the following arguments are required: ${required.map((option) => `--${option.name}`).join(", ")}`);
  }
}

/** Parses argv, with argparse-style messages. Throws UsageError, or returns help text to print. */
export function parse(argv: string[], specs: Record<string, CommandSpec>): Parsed | { help: string } {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError(`the following arguments are required: command\n${mainHelp(specs)}`);
  if (name === "-h" || name === "--help") return { help: mainHelp(specs) };
  if (name === "-V" || name === "--version") return { help: `${version()}\n` };
  const spec = specs[name];
  if (!spec) throw new UsageError(`argument command: invalid choice: ${quote(name)}`);
  const args: Args = {};
  const positionals: string[] = [];
  const byName = new Map(spec.options.map((option) => [option.name, option]));
  for (const option of spec.options) args[option.name.replaceAll("-", "_")] = optionDefault(option);
  const fail: Fail = (message) => new UsageError(`${usage(name, spec)}\nwebhand ${name}: error: ${message}`);
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "-h" || token === "--help") return { help: help(name, spec) };
    if (token === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith("--") || token === "-") {
      positionals.push(token);
      continue;
    }
    const at = token.indexOf("=");
    const option = byName.get(at < 0 ? token.slice(2) : token.slice(2, at));
    if (!option) throw fail(`unrecognized arguments: ${token}`);
    const key = option.name.replaceAll("-", "_");
    seen.add(option.name);
    if (option.type === "boolean") {
      if (at >= 0) throw fail(`argument --${option.name}: ignored explicit argument ${quote(token.slice(at + 1))}`);
      args[key] = true;
      continue;
    }
    const [raw, took] = optionText(option, token, rest[i + 1], fail);
    i += took;
    const value = optionValue(option, raw, fail);
    if (option.multiple) args[key].push(value);
    else args[key] = value;
  }
  bindPositionals(spec, positionals, args, fail);
  checkOptions(spec, seen, fail);
  return { command: name, args, run: spec.run };
}
