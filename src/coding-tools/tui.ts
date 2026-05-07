export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
