export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  hideCursor(): void;
  showCursor(): void;
  clearScreen(): void;
}

export class ProcessTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", onResize);
  }

  stop(): void {
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.resizeHandler!);
    process.stdin.setRawMode?.(this.wasRaw);
    process.stdin.pause();
    this.showCursor();
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns ?? 80;
  }
  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  hideCursor(): void {
    process.stdout.write("\x1b[?25l");
  }
  showCursor(): void {
    process.stdout.write("\x1b[?25h");
  }
  clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  private onData = (data: string) => {
    this.inputHandler?.(data);
  };
}
