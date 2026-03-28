import { App, Modal, Notice, Setting } from "obsidian";
import type PaperDailyPlugin from "../main";
import { FloatingProgress } from "./floatingProgress";
import { regenerateDigest } from "../pipeline/regeneratePipeline";

export class RegenerateModal extends Modal {
  private plugin: PaperDailyPlugin;

  constructor(app: App, plugin: PaperDailyPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Regenerate AI Digest" });

    const today = new Date().toISOString().slice(0, 10);
    let dateInput!: HTMLInputElement;

    new Setting(contentEl)
      .setName("Date")
      .addText(text => {
        dateInput = text.inputEl;
        dateInput.type = "date";
        dateInput.value = today;
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText("Cancel")
        .onClick(() => this.close()))
      .addButton(btn => btn
        .setButtonText("Regenerate")
        .setCta()
        .onClick(() => {
          const date = dateInput.value;
          if (!date) return;
          this.close();

          const controller = new AbortController();
          const fp = new FloatingProgress(() => {
            controller.abort();
            fp.setMessage("Stopping...");
          }, "Regenerating AI Digest");

          regenerateDigest(this.app, this.plugin.settings, date, {
            signal: controller.signal,
            onProgress: (msg) => fp.setMessage(msg)
          }).then(() => {
            fp.setMessage("Done.");
            new Notice("Paper Daily: Digest regenerated for " + date);
            setTimeout(() => fp.destroy(), 3000);
          }).catch((err: Error) => {
            fp.setMessage("Error: " + err.message);
            new Notice("Paper Daily Error: " + err.message);
            setTimeout(() => fp.destroy(), 6000);
          });
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
