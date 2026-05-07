import type { Component } from "./tui.js";

export class Input implements Component {
  private value = "";
  private cursor = 0;
  focused = true;
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  onChange?: () => void;

  getValue(): string {
    return this.value;
  }
  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  render(width: number): string[] {
    const before = this.value.slice(0, this.cursor);
    const after = this.value.slice(this.cursor);
    const cursorChar = this.focused ? "\x1b[7m \x1b[27m" : " ";
    let line = `› ${before}${cursorChar}${after}`;
    if (line.length > width) line = line.slice(line.length - width);
    return [line];
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
      this.value = "";
      this.cursor = 0;
    } else if (data === "\x1b") {
      this.onEscape?.();
    } else if (data === "\x7f") {
      // backspace
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor--;
      }
    } else if (data === "\x1b[D") {
      if (this.cursor > 0) this.cursor--;
    } else if (data === "\x1b[C") {
      if (this.cursor < this.value.length) this.cursor++;
    } else if (data >= " " && !data.startsWith("\x1b")) {
      this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
      this.cursor += data.length;
    }
    this.onChange?.();
  }

  invalidate(): void {}
}
