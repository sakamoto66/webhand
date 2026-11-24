/** Download capture for local Chrome sessions with --download-dir. */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrowserContext, Download, Page as PlaywrightPage } from "playwright-core";
import { sleep } from "../core/format.ts";

const DOWNLOAD_START_MS = 1500;
const DOWNLOAD_DONE_MS = 60_000;

export class DownloadTracker {
  private readonly dir: string | null;
  private downloaded: { name: string; bytes: number }[] = [];
  private readonly saving: Promise<unknown>[] = [];

  constructor(downloadDir: string | null) {
    this.dir = downloadDir;
  }

  /** Saves what the pages download into the download directory. Playwright holds a download until it is saved. */
  allow(context: BrowserContext): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const watch = (page: PlaywrightPage) => {
      page.on("download", (download) => {
        this.saving.push(this.save(download).catch(() => null));
      });
    };
    for (const page of context.pages()) watch(page);
    context.on("page", watch);
  }

  private async save(download: Download): Promise<void> {
    const dir = this.dir as string;
    const wanted = basename(download.suggestedFilename()) || "download";
    const dot = wanted.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    let name = wanted;
    // Never over an existing file: a repeated name gets " (1)".
    for (let n = 1; existsSync(join(dir, name)); n++) name = `${stem} (${n})${extension}`;
    await download.saveAs(join(dir, name));
    this.downloaded.push({ name, bytes: statSync(join(dir, name)).size });
  }

  /** The files the last act downloaded, once. */
  take(): { name: string; bytes: number }[] {
    const found = this.downloaded;
    this.downloaded = [];
    return found;
  }

  /** After an input that may start a download: waits for one to begin, then for every one to be saved. */
  async collect(): Promise<void> {
    if (!this.dir) return;
    const started = Date.now();
    while (Date.now() - started < DOWNLOAD_START_MS && this.saving.length === 0) await sleep(100);
    const saving = this.saving.splice(0);
    if (!saving.length) return;
    await Promise.race([Promise.all(saving), sleep(DOWNLOAD_DONE_MS)]);
  }
}
